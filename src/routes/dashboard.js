const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const prisma = require('../db');
const config = require('../config');
const asyncHandler = require('../lib/asyncHandler');
const { requireDashboardAuth } = require('../middleware/auth');
const { expirePendingPayments } = require('../services/poller');
const { TIERS } = require('../lib/feeTiers');
const { parseDateRange } = require('../lib/dateRange');
const subscriptionService = require('../services/subscriptionService');
const { generateWebhookSecret, sendTestWebhook } = require('../services/webhookService');
const { sendSecurityAlertEmail } = require('../services/emailService');
const { logger, safeError } = require('../lib/logger');

const router = express.Router();
router.use(requireDashboardAuth);

router.get('/summary', asyncHandler(async (req, res) => {
  await expirePendingPayments();
  const businessId = req.auth.businessId;
  const unitId = req.query.business_unit_id || undefined;
  const unitWhere = unitId ? { businessUnitId: unitId } : {};
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (unitId) {
    const unit = await prisma.businessUnit.findFirst({ where: { id: unitId, businessId } });
    if (!unit) return res.status(404).json({ success: false, message: 'Sub-business not found' });
  }
  const [groups, total, connections, units] = await Promise.all([
    prisma.payment.groupBy({ by: ['status'], where: { businessId, ...unitWhere, createdAt: { gte: today } }, _count: true, _sum: { amount: true } }),
    prisma.payment.aggregate({ where: { businessId, ...unitWhere, status: 'SUCCESS' }, _sum: { amount: true }, _count: true }),
    prisma.merchantConnection.count({ where: { businessId, status: 'ACTIVE' } }),
    prisma.businessUnit.findMany({ where: { businessId, active: true }, orderBy: { createdAt: 'asc' } }),
  ]);
  const stats = Object.fromEntries(groups.map(row => [row.status, { count: row._count, amount: Number(row._sum.amount || 0) }]));
  res.json({ success: true, summary: { today: stats, lifetime: { count: total._count, amount: Number(total._sum.amount || 0) }, activeConnections: connections, businessUnits: units } });
}));

router.get('/payments', asyncHandler(async (req, res) => {
  await expirePendingPayments();
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  const status = req.query.status && ['PENDING', 'SUCCESS', 'FAILED', 'EXPIRED'].includes(req.query.status) ? req.query.status : undefined;
  const unitId = req.query.business_unit_id || undefined;
  if (unitId) {
    const unit = await prisma.businessUnit.findFirst({ where: { id: unitId, businessId: req.auth.businessId } });
    if (!unit) return res.status(404).json({ success: false, message: 'Sub-business not found' });
  }
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;
  const validFrom = from && !Number.isNaN(from.getTime()) ? from : null;
  const validTo = to && !Number.isNaN(to.getTime()) ? to : null;
  const where = { businessId: req.auth.businessId, ...(unitId ? { businessUnitId: unitId } : {}), ...(status ? { status } : {}),
    ...((validFrom || validTo) ? { createdAt: { ...(validFrom ? { gte: validFrom } : {}), ...(validTo ? { lte: validTo } : {}) } } : {}),
  };
  const [items, total, collection] = await Promise.all([
    prisma.payment.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit, include: { businessUnit: { select: { id: true, name: true, code: true } }, connection: { select: { legalBusinessName: true, merchantId: true, provider: true } } } }),
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

// ---- Webhooks ------------------------------------------------------------

function notifyWebhookSecurityAlert(businessId, action, detail) {
  prisma.business.findUnique({ where: { id: businessId }, select: { name: true, supportEmail: true } })
    .then(business => {
      if (!business?.supportEmail) return;
      return sendSecurityAlertEmail({ email: business.supportEmail, businessName: business.name, action, detail });
    })
    .catch(error => logger.error('Security alert email failed', { event: 'SECURITY_ALERT_EMAIL_FAILED', businessId, action, ...safeError(error) }));
}

router.get('/webhook', asyncHandler(async (req, res) => {
  const business = await prisma.business.findUnique({ where: { id: req.auth.businessId }, select: { webhookUrl: true, webhookSecret: true } });
  res.json({ success: true, webhook: { url: business.webhookUrl, secretConfigured: Boolean(business.webhookSecret), secret: business.webhookSecret } });
}));

router.patch('/webhook', asyncHandler(async (req, res) => {
  const { url } = z.object({ url: z.string().url().max(500).nullable() }).parse(req.body);
  const existing = await prisma.business.findUnique({ where: { id: req.auth.businessId }, select: { webhookSecret: true } });
  const data = { webhookUrl: url };
  if (url && !existing.webhookSecret) data.webhookSecret = generateWebhookSecret();
  if (!url) { data.webhookSecret = null; }
  const business = await prisma.business.update({ where: { id: req.auth.businessId }, data });
  logger.info('Webhook URL updated', { event: 'WEBHOOK_URL_UPDATED', requestId: req.id, businessId: req.auth.businessId, url });
  notifyWebhookSecurityAlert(req.auth.businessId, 'Webhook URL updated', url ? `New webhook URL: ${url}` : 'Webhook disabled');
  res.json({ success: true, webhook: { url: business.webhookUrl, secretConfigured: Boolean(business.webhookSecret), secret: business.webhookSecret } });
}));

router.post('/webhook/regenerate-secret', asyncHandler(async (req, res) => {
  const secret = generateWebhookSecret();
  const business = await prisma.business.update({ where: { id: req.auth.businessId }, data: { webhookSecret: secret } });
  logger.warn('Webhook secret regenerated', { event: 'WEBHOOK_SECRET_REGENERATED', requestId: req.id, businessId: req.auth.businessId });
  notifyWebhookSecurityAlert(req.auth.businessId, 'Webhook secret regenerated', 'Your webhook signing secret was regenerated. Update your endpoint if it verifies signatures.');
  res.json({ success: true, webhook: { url: business.webhookUrl, secretConfigured: true, secret: business.webhookSecret } });
}));

router.post('/webhook/test', asyncHandler(async (req, res) => {
  const business = await prisma.business.findUnique({ where: { id: req.auth.businessId } });
  const result = await sendTestWebhook(business);
  res.json({ success: true, result });
}));

router.get('/webhook/deliveries', asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)));
  const where = { businessId: req.auth.businessId };
  const [items, total] = await Promise.all([
    prisma.webhookDelivery.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.webhookDelivery.count({ where }),
  ]);
  res.json({ success: true, deliveries: items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
}));

// ---- Business units / sub-businesses -----------------------------------

const unitInput = z.object({
  name: z.string().min(2).max(100),
  code: z.string().min(2).max(40).regex(/^[a-z0-9][a-z0-9_-]*$/i, 'Use letters, numbers, dash or underscore.'),
  description: z.string().max(250).optional().nullable(),
  active: z.boolean().optional(),
});

router.get('/business-units', asyncHandler(async (req, res) => {
  const units = await prisma.businessUnit.findMany({
    where: { businessId: req.auth.businessId },
    orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
    include: { _count: { select: { payments: true } } },
  });
  res.json({ success: true, units });
}));

router.post('/business-units', asyncHandler(async (req, res) => {
  const input = unitInput.parse(req.body);
  const code = input.code.toLowerCase();
  const exists = await prisma.businessUnit.findUnique({ where: { businessId_code: { businessId: req.auth.businessId, code } } });
  if (exists) return res.status(409).json({ success: false, message: 'A sub-business with this code already exists.' });
  const unit = await prisma.businessUnit.create({
    data: { businessId: req.auth.businessId, name: input.name, code, description: input.description || null, active: input.active ?? true },
  });
  logger.info('Business unit created', { event: 'BUSINESS_UNIT_CREATED', requestId: req.id, businessId: req.auth.businessId, businessUnitId: unit.id, code: unit.code });
  res.status(201).json({ success: true, unit });
}));

router.patch('/business-units/:id', asyncHandler(async (req, res) => {
  const input = unitInput.partial().parse(req.body);
  const existing = await prisma.businessUnit.findFirst({ where: { id: req.params.id, businessId: req.auth.businessId } });
  if (!existing) return res.status(404).json({ success: false, message: 'Sub-business not found' });
  if (input.code) {
    const codeExists = await prisma.businessUnit.findFirst({ where: { businessId: req.auth.businessId, code: input.code.toLowerCase(), id: { not: existing.id } } });
    if (codeExists) return res.status(409).json({ success: false, message: 'A sub-business with this code already exists.' });
  }
  const unit = await prisma.businessUnit.update({
    where: { id: existing.id },
    data: {
      ...(input.name ? { name: input.name } : {}),
      ...(input.code ? { code: input.code.toLowerCase() } : {}),
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });
  logger.info('Business unit updated', { event: 'BUSINESS_UNIT_UPDATED', requestId: req.id, businessId: req.auth.businessId, businessUnitId: unit.id, active: unit.active });
  res.json({ success: true, unit });
}));

router.get('/insights', asyncHandler(async (req, res) => {
  const businessId = req.auth.businessId;
  const { from, to } = parseDateRange(req.query);
  const unitId = req.query.business_unit_id || undefined;
  if (unitId) {
    const unit = await prisma.businessUnit.findFirst({ where: { id: unitId, businessId } });
    if (!unit) return res.status(404).json({ success: false, message: 'Sub-business not found' });
  }
  const rangeWhere = { businessId, createdAt: { gte: from, lte: to }, ...(unitId ? { businessUnitId: unitId } : {}) };

  const [statusGroups, successAgg, units, dailyPayments, unitStatusGroups] = await Promise.all([
    prisma.payment.groupBy({ by: ['status'], where: rangeWhere, _count: true, _sum: { amount: true } }),
    prisma.payment.aggregate({ where: { ...rangeWhere, status: 'SUCCESS' }, _sum: { amount: true }, _count: true, _avg: { amount: true } }),
    prisma.businessUnit.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
    prisma.payment.findMany({ where: { ...rangeWhere, status: 'SUCCESS' }, select: { amount: true, paidAt: true, createdAt: true } }),
    prisma.payment.groupBy({ by: ['businessUnitId', 'status'], where: { businessId, createdAt: { gte: from, lte: to } }, _count: true, _sum: { amount: true } }),
  ]);

  const byStatus = Object.fromEntries(statusGroups.map(row => [row.status, { count: row._count, amount: Number(row._sum.amount || 0) }]));
  const totalCount = statusGroups.reduce((sum, row) => sum + row._count, 0);

  const dayBuckets = {};
  for (const payment of dailyPayments) {
    const day = (payment.paidAt || payment.createdAt).toISOString().slice(0, 10);
    if (!dayBuckets[day]) dayBuckets[day] = { day, count: 0, amount: 0 };
    dayBuckets[day].count += 1;
    dayBuckets[day].amount += Number(payment.amount);
  }
  const trend = Object.values(dayBuckets).sort((a, b) => a.day.localeCompare(b.day));

  const unitMap = new Map(units.map(unit => [unit.id, { id: unit.id, name: unit.name, code: unit.code, amount: 0, successCount: 0, totalCount: 0 }]));
  unitMap.set('__general__', { id: null, name: 'General (no sub-business)', code: null, amount: 0, successCount: 0, totalCount: 0 });
  for (const row of unitStatusGroups) {
    const key = row.businessUnitId || '__general__';
    const bucket = unitMap.get(key);
    if (!bucket) continue;
    bucket.totalCount += row._count;
    if (row.status === 'SUCCESS') { bucket.successCount += row._count; bucket.amount += Number(row._sum.amount || 0); }
  }
  const byUnit = Array.from(unitMap.values())
    .filter(unit => unit.totalCount > 0)
    .map(unit => ({ ...unit, successRate: unit.totalCount ? unit.successCount / unit.totalCount : 0 }))
    .sort((a, b) => b.amount - a.amount);

  res.json({
    success: true,
    range: { from, to },
    summary: {
      totalCount, successCount: successAgg._count, amount: Number(successAgg._sum.amount || 0),
      avgAmount: Number(successAgg._avg.amount || 0),
      successRate: totalCount ? successAgg._count / totalCount : 0,
    },
    byStatus, trend, byUnit,
  });
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

router.post('/subscription/trial/activate', asyncHandler(async (req, res) => {
  const trial = await subscriptionService.activateTrial(req.auth.businessId);
  const usage = await subscriptionService.getUsageSummary(req.auth.businessId);
  logger.info('Subscription trial activated from dashboard', { event: 'DASHBOARD_TRIAL_ACTIVATED', requestId: req.id, businessId: req.auth.businessId });
  res.status(201).json({ success: true, trial, usage });
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

// ---- Refunds --------------------------------------------------------------
// Pay-Panda never holds customer money (UPI passthrough directly into the business's own
// bank account), so it has no technical ability to pull money back automatically. These
// endpoints are a status/audit trail only: the business marks a SUCCESS payment as
// "refund requested" and later "refunded" once they've sent the money back themselves via
// their own UPI app, recording the UTR/reference they used.

router.post('/payments/:id/refund-request', asyncHandler(async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
  const payment = await prisma.payment.findFirst({ where: { id: req.params.id, businessId: req.auth.businessId } });
  if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
  if (payment.status !== 'SUCCESS') return res.status(400).json({ success: false, message: 'Only successful payments can be marked for refund.' });
  if (payment.refundStatus !== 'NONE') return res.status(409).json({ success: false, message: 'A refund has already been requested for this payment.' });
  const updated = await prisma.payment.update({ where: { id: payment.id }, data: { refundStatus: 'REQUESTED', refundReason: reason, refundRequestedAt: new Date() } });
  logger.info('Refund requested', { event: 'REFUND_REQUESTED', requestId: req.id, businessId: req.auth.businessId, paymentId: payment.publicId });
  res.json({ success: true, payment: updated });
}));

router.post('/payments/:id/refund-complete', asyncHandler(async (req, res) => {
  const { reference } = z.object({ reference: z.string().min(3).max(120) }).parse(req.body);
  const payment = await prisma.payment.findFirst({ where: { id: req.params.id, businessId: req.auth.businessId } });
  if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
  if (payment.refundStatus !== 'REQUESTED') return res.status(400).json({ success: false, message: 'Refund must be requested before it can be marked complete.' });
  const updated = await prisma.payment.update({ where: { id: payment.id }, data: { refundStatus: 'REFUNDED', refundReference: reference, refundedAt: new Date() } });
  logger.info('Refund marked complete', { event: 'REFUND_COMPLETED', requestId: req.id, businessId: req.auth.businessId, paymentId: payment.publicId });
  res.json({ success: true, payment: updated });
}));

// ---- Complaints (business side) -------------------------------------------

router.get('/complaints', asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)));
  const status = req.query.status && ['OPEN', 'INVESTIGATING', 'RESOLVED'].includes(req.query.status) ? req.query.status : undefined;
  const where = { businessId: req.auth.businessId, ...(status ? { status } : {}) };
  const [items, total] = await Promise.all([
    prisma.paymentComplaint.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit, include: { payment: { select: { publicId: true, clientOrderId: true, amount: true, status: true } } } }),
    prisma.paymentComplaint.count({ where }),
  ]);
  res.json({ success: true, complaints: items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
}));

router.post('/payments/:id/complaints', asyncHandler(async (req, res) => {
  const { message, filerName, filerContact } = z.object({
    message: z.string().min(5).max(1000), filerName: z.string().max(120).optional(), filerContact: z.string().max(200).optional(),
  }).parse(req.body);
  const payment = await prisma.payment.findFirst({ where: { id: req.params.id, businessId: req.auth.businessId } });
  if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
  const complaint = await prisma.paymentComplaint.create({
    data: { paymentId: payment.id, businessId: req.auth.businessId, filedBy: 'BUSINESS', filerName, filerContact, message },
  });
  logger.info('Complaint filed by business', { event: 'COMPLAINT_FILED', requestId: req.id, businessId: req.auth.businessId, paymentId: payment.publicId, complaintId: complaint.id });
  res.status(201).json({ success: true, complaint });
}));

module.exports = router;
