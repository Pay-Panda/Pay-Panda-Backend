const prisma = require('../db');
const { createPayment, publicPayment } = require('./paymentService');
const { logger } = require('../lib/logger');

function monthRange(date) {
  const periodStart = new Date(date.getFullYear(), date.getMonth(), 1);
  const periodEnd = new Date(date.getFullYear(), date.getMonth() + 1, 1);
  return { periodStart, periodEnd };
}

async function getUsageSummary(businessId) {
  const business = await prisma.business.findUnique({ where: { id: businessId }, include: { plan: true } });
  const { periodStart, periodEnd } = monthRange(new Date());
  const [paymentCount, feeAgg] = await Promise.all([
    prisma.payment.count({ where: { businessId, status: 'SUCCESS', paidAt: { gte: periodStart, lt: periodEnd } } }),
    prisma.payment.aggregate({ where: { businessId, status: 'SUCCESS', paidAt: { gte: periodStart, lt: periodEnd } }, _sum: { platformFeeAmount: true } }),
  ]);
  return {
    plan: business.plan,
    period: { start: periodStart, end: periodEnd },
    paymentCount,
    monthlyPaymentLimit: business.plan?.monthlyPaymentLimit ?? null,
    accruedFeeAmount: Number(feeAgg._sum.platformFeeAmount || 0),
  };
}

/** Idempotently creates a PENDING invoice for the most recently completed calendar
 * month, if the business had billable payments in that month and no invoice exists
 * for it yet. Safe to call on every subscription-history view. */
async function ensurePreviousMonthInvoice(businessId) {
  const { periodStart, periodEnd } = monthRange(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1));
  const existing = await prisma.subscriptionInvoice.findUnique({ where: { businessId_periodStart: { businessId, periodStart } } });
  if (existing) return existing;
  const [paymentCount, feeAgg] = await Promise.all([
    prisma.payment.count({ where: { businessId, status: 'SUCCESS', paidAt: { gte: periodStart, lt: periodEnd } } }),
    prisma.payment.aggregate({ where: { businessId, status: 'SUCCESS', paidAt: { gte: periodStart, lt: periodEnd } }, _sum: { platformFeeAmount: true } }),
  ]);
  const totalFeeAmount = Number(feeAgg._sum.platformFeeAmount || 0);
  if (!paymentCount || totalFeeAmount <= 0) return null;
  try {
    const invoice = await prisma.subscriptionInvoice.create({ data: { businessId, periodStart, periodEnd, paymentCount, totalFeeAmount } });
    logger.info('Subscription invoice generated', { event: 'SUBSCRIPTION_INVOICE_CREATED', businessId, invoiceId: invoice.id, periodStart, paymentCount, totalFeeAmount });
    return invoice;
  } catch (error) {
    if (error.code === 'P2002') return prisma.subscriptionInvoice.findUnique({ where: { businessId_periodStart: { businessId, periodStart } } });
    throw error;
  }
}

/** Creates the internal collection Payment for a PENDING invoice against the
 * platform's own BharatPe connection, so the business can pay it through the
 * normal checkout/QR pipeline. Returns null if no platform connection is configured. */
async function createInvoiceCollectionPayment(invoice) {
  const platformBusiness = await prisma.business.findFirst({ where: { isPlatform: true } });
  if (!platformBusiness) return null;
  const [invoiceBusiness] = await Promise.all([prisma.business.findUnique({ where: { id: invoice.businessId } })]);
  const periodLabel = invoice.periodStart.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const { payment } = await createPayment(platformBusiness.id, {
    orderId: `SUB-${invoice.id}`,
    amount: Number(invoice.totalFeeAmount),
    customerName: invoiceBusiness?.name,
    reason: `Pay-Panda platform fee — ${periodLabel}`,
    remark1: `${invoice.paymentCount} payments processed`,
  }, 'SUBSCRIPTION');
  const updated = await prisma.subscriptionInvoice.update({ where: { id: invoice.id }, data: { paymentId: payment.id } });
  return { invoice: updated, payment };
}

/** Mirrors the linked collection Payment's real status onto the invoice (lazy sync,
 * no webhook needed — the same poller/reconciliation flow already keeps Payment
 * status current). */
async function syncInvoiceStatus(invoice) {
  if (invoice.status !== 'PENDING' || !invoice.paymentId) return invoice;
  const payment = await prisma.payment.findUnique({ where: { id: invoice.paymentId } });
  if (!payment) return invoice;
  if (payment.status === 'SUCCESS') {
    return prisma.subscriptionInvoice.update({ where: { id: invoice.id }, data: { status: 'PAID', paidAt: payment.paidAt } });
  }
  if (payment.status === 'EXPIRED') {
    return prisma.subscriptionInvoice.update({ where: { id: invoice.id }, data: { status: 'EXPIRED' } });
  }
  return invoice;
}

async function listInvoices(businessId) {
  await ensurePreviousMonthInvoice(businessId);
  const invoices = await prisma.subscriptionInvoice.findMany({ where: { businessId }, orderBy: { periodStart: 'desc' } });
  const synced = [];
  for (const invoice of invoices) synced.push(await syncInvoiceStatus(invoice));
  const withPayments = await Promise.all(synced.map(async invoice => {
    if (!invoice.paymentId) return { ...invoice, checkoutUrl: null };
    const payment = await prisma.payment.findUnique({ where: { id: invoice.paymentId } });
    return { ...invoice, checkoutUrl: payment ? publicPayment(payment).checkoutUrl : null };
  }));
  return withPayments;
}

module.exports = { getUsageSummary, ensurePreviousMonthInvoice, createInvoiceCollectionPayment, syncInvoiceStatus, listInvoices };
