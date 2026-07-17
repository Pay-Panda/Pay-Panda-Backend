const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const prisma = require('../db');
const config = require('../config');
const asyncHandler = require('../lib/asyncHandler');
const { requireDashboardAuth } = require('../middleware/auth');
const { expirePendingPayments } = require('../services/poller');
const { TIERS } = require('../lib/feeTiers');
const subscriptionService = require('../services/subscriptionService');
const { logger } = require('../lib/logger');

const router = express.Router();
router.use(requireDashboardAuth);

router.get('/summary', asyncHandler(async (req, res) => {
  await expirePendingPayments();
  const businessId = req.auth.businessId;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [groups, total, connections] = await Promise.all([
    prisma.payment.groupBy({ by: ['status'], where: { businessId, createdAt: { gte: today } }, _count: true, _sum: { amount: true } }),
    prisma.payment.aggregate({ where: { businessId, status: 'SUCCESS' }, _sum: { amount: true }, _count: true }),
    prisma.merchantConnection.count({ where: { businessId, status: 'ACTIVE' } }),
  ]);
  const stats = Object.fromEntries(groups.map(row => [row.status, { count: row._count, amount: Number(row._sum.amount || 0) }]));
  res.json({ success: true, summary: { today: stats, lifetime: { count: total._count, amount: Number(total._sum.amount || 0) }, activeConnections: connections } });
}));

router.get('/payments', asyncHandler(async (req, res) => {
  await expirePendingPayments();
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  const status = req.query.status && ['PENDING', 'SUCCESS', 'FAILED', 'EXPIRED'].includes(req.query.status) ? req.query.status : undefined;
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;
  const validFrom = from && !Number.isNaN(from.getTime()) ? from : null;
  const validTo = to && !Number.isNaN(to.getTime()) ? to : null;
  const where = { businessId: req.auth.businessId, ...(status ? { status } : {}),
    ...((validFrom || validTo) ? { createdAt: { ...(validFrom ? { gte: validFrom } : {}), ...(validTo ? { lte: validTo } : {}) } } : {}),
  };
  const [items, total, collection] = await Promise.all([
    prisma.payment.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit, include: { connection: { select: { legalBusinessName: true, merchantId: true, provider: true } } } }),
    prisma.payment.count({ where }),
    prisma.payment.aggregate({ where: { ...where, status: 'SUCCESS' }, _sum: { amount: true }, _count: true }),
  ]);
  res.json({ success: true, payments: items.map(({ qrImage, upiIntent, ...item }) => item), summary: { collectedAmount: Number(collection._sum.amount || 0), successfulCount: collection._count }, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
}));

router.patch('/settings', asyncHandler(async (req, res) => {
  const { paymentExpiryMins } = z.object({ paymentExpiryMins: z.coerce.number().int().min(1).max(60) }).parse(req.body);
  const business = await prisma.business.update({ where: { id: req.auth.businessId }, data: { paymentExpiryMins } });
  res.json({ success: true, business });
}));

router.get('/provider-transactions', asyncHandler(async (req, res) => {
  const items = await prisma.providerTransaction.findMany({ where: { businessId: req.auth.businessId }, orderBy: { paymentTimestamp: 'desc' }, take: 100 });
  res.json({ success: true, transactions: items.map(({ rawData, ...item }) => item) });
}));

// ---- Payment options & theme -------------------------------------------

router.patch('/payment-options', asyncHandler(async (req, res) => {
  const { checkoutLayout } = z.object({ checkoutLayout: z.enum(['qr', 'button', 'both']) }).parse(req.body);
  const business = await prisma.business.update({ where: { id: req.auth.businessId }, data: { checkoutLayout } });
  res.json({ success: true, business });
}));

router.patch('/theme', asyncHandler(async (req, res) => {
  const { theme } = z.object({ theme: z.enum(['midnight', 'daylight', 'emerald', 'sunrise']) }).parse(req.body);
  const business = await prisma.business.update({ where: { id: req.auth.businessId }, data: { theme } });
  res.json({ success: true, business });
}));

// ---- Plans (read-only reference for the business) -----------------------

router.get('/plans', asyncHandler(async (req, res) => {
  const plans = await prisma.plan.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
  res.json({ success: true, plans });
}));

// ---- Subscription usage & billing ----------------------------------------

router.get('/subscription', asyncHandler(async (req, res) => {
  const usage = await subscriptionService.getUsageSummary(req.auth.businessId);
  res.json({ success: true, usage, feeTiers: TIERS });
}));

router.get('/subscription/invoices', asyncHandler(async (req, res) => {
  const invoices = await subscriptionService.listInvoices(req.auth.businessId);
  res.json({ success: true, invoices });
}));

router.post('/subscription/invoices/:id/pay', asyncHandler(async (req, res) => {
  const invoice = await prisma.subscriptionInvoice.findFirst({ where: { id: req.params.id, businessId: req.auth.businessId } });
  if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });
  if (invoice.status !== 'PENDING') return res.status(409).json({ success: false, message: 'This invoice is not payable.' });
  if (invoice.paymentId) {
    const payment = await prisma.payment.findUnique({ where: { id: invoice.paymentId } });
    if (payment && payment.status !== 'EXPIRED') return res.json({ success: true, checkoutUrl: `${config.publicAppUrl}/pay/${payment.publicId}` });
  }
  const result = await subscriptionService.createInvoiceCollectionPayment(invoice);
  if (!result) return res.status(503).json({ success: false, message: 'Fee collection is not configured yet. Contact support.' });
  logger.info('Subscription invoice payment created', { event: 'SUBSCRIPTION_INVOICE_PAY', requestId: req.id, businessId: req.auth.businessId, invoiceId: invoice.id, paymentId: result.payment.id });
  res.json({ success: true, checkoutUrl: `${config.publicAppUrl}/pay/${result.payment.publicId}` });
}));

// ---- Default link ---------------------------------------------------------

router.get('/default-link', asyncHandler(async (req, res) => {
  const link = await prisma.defaultLink.findUnique({ where: { businessId: req.auth.businessId } });
  res.json({ success: true, link: link ? { ...link, url: `${config.publicAppUrl}/pay/link/${link.slug}` } : null });
}));

const linkInput = z.object({
  label: z.string().max(80).optional(),
  minAmount: z.coerce.number().positive().optional().nullable(),
  maxAmount: z.coerce.number().positive().optional().nullable(),
  active: z.boolean().optional(),
}).refine(value => !(value.minAmount && value.maxAmount) || value.minAmount <= value.maxAmount, { message: 'Minimum amount must not exceed maximum amount.' });

router.post('/default-link', asyncHandler(async (req, res) => {
  const existing = await prisma.defaultLink.findUnique({ where: { businessId: req.auth.businessId } });
  if (existing) return res.status(409).json({ success: false, message: 'A default link already exists for this business.' });
  const input = linkInput.parse(req.body);
  const slug = crypto.randomBytes(6).toString('base64url');
  const link = await prisma.defaultLink.create({ data: { businessId: req.auth.businessId, slug, ...input } });
  logger.info('Default link created', { event: 'DEFAULT_LINK_CREATED', requestId: req.id, businessId: req.auth.businessId, linkId: link.id });
  res.status(201).json({ success: true, link: { ...link, url: `${config.publicAppUrl}/pay/link/${link.slug}` } });
}));

router.patch('/default-link', asyncHandler(async (req, res) => {
  const input = linkInput.parse(req.body);
  const link = await prisma.defaultLink.update({ where: { businessId: req.auth.businessId }, data: input });
  res.json({ success: true, link: { ...link, url: `${config.publicAppUrl}/pay/link/${link.slug}` } });
}));

module.exports = router;
