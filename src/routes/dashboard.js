const express = require('express');
const prisma = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { requireDashboardAuth } = require('../middleware/auth');
const { expirePendingPayments } = require('../services/poller');

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
  const { paymentExpiryMins } = require('zod').z.object({ paymentExpiryMins: require('zod').z.coerce.number().int().min(1).max(60) }).parse(req.body);
  const business = await prisma.business.update({ where: { id: req.auth.businessId }, data: { paymentExpiryMins } });
  res.json({ success: true, business });
}));

router.get('/provider-transactions', asyncHandler(async (req, res) => {
  const items = await prisma.providerTransaction.findMany({ where: { businessId: req.auth.businessId }, orderBy: { paymentTimestamp: 'desc' }, take: 100 });
  res.json({ success: true, transactions: items.map(({ rawData, ...item }) => item) });
}));

module.exports = router;
