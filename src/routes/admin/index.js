const express = require('express');
const { z } = require('zod');
const prisma = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const { requireAdminAuth } = require('../../middleware/auth');
const { parseDateRange } = require('../../lib/dateRange');
const { logger } = require('../../lib/logger');

const router = express.Router();
router.use(requireAdminAuth);
const ADMIN_CACHE_MS = 15000;
const cache = new Map();
const businessUnitInput = z.object({
  name: z.string().min(2).max(100),
  code: z.string().min(2).max(40).regex(/^[a-z0-9][a-z0-9_-]*$/i, 'Use letters, numbers, dash or underscore.'),
  description: z.string().max(250).optional().nullable(),
  active: z.boolean().optional(),
});

// ---- Insights ----------------------------------------------------------

router.get('/insights/overview', asyncHandler(async (req, res) => {
  const { from, to } = parseDateRange(req.query);
  const cacheKey = `overview:${from.toISOString()}:${to.toISOString()}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);
  const [businessCount, activeCount, suspendedCount, userCount, paymentTotals, rangePaymentTotals, planGroups, recentBusinesses, dailyPayments, businessGroups] = await Promise.all([
    prisma.business.count(),
    prisma.business.count({ where: { suspendedAt: null } }),
    prisma.business.count({ where: { suspendedAt: { not: null } } }),
    prisma.user.count(),
    prisma.payment.aggregate({ where: { status: 'SUCCESS' }, _sum: { amount: true }, _count: true }),
    prisma.payment.aggregate({ where: { status: 'SUCCESS', paidAt: { gte: from, lte: to } }, _sum: { amount: true }, _count: true }),
    prisma.business.groupBy({ by: ['planId'], _count: true }),
    prisma.business.findMany({ orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, name: true, createdAt: true, suspendedAt: true } }),
    prisma.payment.findMany({ where: { status: 'SUCCESS', paidAt: { gte: from, lte: to } }, select: { amount: true, paidAt: true } }),
    prisma.payment.groupBy({ by: ['businessId'], where: { status: 'SUCCESS', paidAt: { gte: from, lte: to } }, _count: true, _sum: { amount: true }, orderBy: { _sum: { amount: 'desc' } }, take: 8 }),
  ]);

  const plans = await prisma.plan.findMany({ select: { id: true, name: true } });
  const planNameById = Object.fromEntries(plans.map(plan => [plan.id, plan.name]));
  const planDistribution = planGroups.map(row => ({ planId: row.planId, planName: row.planId ? (planNameById[row.planId] || 'Unknown') : 'No plan', count: row._count }));

  const dayBuckets = {};
  for (const payment of dailyPayments) {
    const day = payment.paidAt.toISOString().slice(0, 10);
    if (!dayBuckets[day]) dayBuckets[day] = { day, count: 0, amount: 0 };
    dayBuckets[day].count += 1;
    dayBuckets[day].amount += Number(payment.amount);
  }
  const trend = Object.values(dayBuckets).sort((a, b) => a.day.localeCompare(b.day));

  const topBusinessNames = await prisma.business.findMany({ where: { id: { in: businessGroups.map(row => row.businessId) } }, select: { id: true, name: true } });
  const nameById = Object.fromEntries(topBusinessNames.map(b => [b.id, b.name]));
  const topBusinesses = businessGroups.map(row => ({
    id: row.businessId, label: nameById[row.businessId] || 'Unknown', amount: Number(row._sum.amount || 0), count: row._count,
  }));

  const payload = {
    success: true,
    overview: {
      businesses: { total: businessCount, active: activeCount, suspended: suspendedCount },
      users: userCount,
      lifetimePayments: { count: paymentTotals._count, amount: Number(paymentTotals._sum.amount || 0) },
      rangePayments: { count: rangePaymentTotals._count, amount: Number(rangePaymentTotals._sum.amount || 0) },
      planDistribution,
      recentBusinesses,
      trend,
      topBusinesses,
      range: { from, to },
    },
  };
  setCached(cacheKey, payload);
  res.json(payload);
}));

// ---- Businesses ---------------------------------------------------------

router.get('/businesses', asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  const search = String(req.query.search || '').trim();
  const status = req.query.status;
  const cacheKey = `businesses:${page}:${limit}:${search}:${status || ''}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);
  const where = {
    ...(search ? { OR: [
      { name: { contains: search, mode: 'insensitive' } },
      { supportEmail: { contains: search, mode: 'insensitive' } },
      { users: { some: { email: { contains: search, mode: 'insensitive' } } } },
    ] } : {}),
    ...(status === 'suspended' ? { suspendedAt: { not: null } } : {}),
    ...(status === 'active' ? { suspendedAt: null } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.business.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit,
      select: {
        id: true, name: true, supportEmail: true, suspendedAt: true, createdAt: true,
        plan: { select: { id: true, name: true } },
        _count: { select: { users: true, payments: true } },
      },
    }),
    prisma.business.count({ where }),
  ]);
  const payload = { success: true, businesses: items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  setCached(cacheKey, payload);
  res.json(payload);
}));

router.get('/businesses/:id', asyncHandler(async (req, res) => {
  const businessId = req.params.id;
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: {
      plan: true,
      users: { select: { id: true, name: true, email: true, mobile: true, role: true, emailVerifiedAt: true, createdAt: true } },
      businessUnits: {
        orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
        include: { _count: { select: { payments: true } } },
      },
      connections: {
        orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
        select: {
          id: true, provider: true, label: true, status: true, mobile: true, merchantId: true, merchantMid: true,
          merchantName: true, legalBusinessName: true, beneficiaryName: true, bankName: true, maskedAccountNumber: true,
          ifsc: true, upiId: true, autoSettlement: true, isDefault: true, lastConnectedAt: true, lastError: true,
          deactivatedAt: true, createdAt: true,
        },
      },
      apiClients: { orderBy: { createdAt: 'desc' }, select: { id: true, name: true, appId: true, active: true, lastUsedAt: true, createdAt: true } },
      defaultLink: { select: { slug: true, label: true, active: true, minAmount: true, maxAmount: true, createdAt: true } },
      _count: { select: { payments: true, businessUnits: true, apiClients: true } },
    },
  });
  if (!business) return res.status(404).json({ success: false, message: 'Business not found' });
  const { from, to } = parseDateRange(req.query);
  const [paymentTotals, statusGroups, unitGroups, dailyPayments, recentPayments, recentProviderTransactions] = await Promise.all([
    prisma.payment.aggregate({ where: { businessId, status: 'SUCCESS' }, _sum: { amount: true }, _count: true }),
    prisma.payment.groupBy({ by: ['status'], where: { businessId }, _count: true, _sum: { amount: true } }),
    prisma.payment.groupBy({ by: ['businessUnitId'], where: { businessId }, _count: true, _sum: { amount: true } }),
    prisma.payment.findMany({ where: { businessId, status: 'SUCCESS', paidAt: { gte: from, lte: to } }, select: { amount: true, paidAt: true } }),
    prisma.payment.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: {
        id: true, publicId: true, businessUnitId: true, clientOrderId: true, customerName: true, customerMobile: true,
        amount: true, currency: true, reason: true, source: true, status: true, bankReferenceNo: true, internalUtr: true,
        payerName: true, payerHandle: true, paidAt: true, expiresAt: true, createdAt: true,
        businessUnit: { select: { id: true, name: true, code: true } },
        connection: { select: { id: true, provider: true, label: true, merchantId: true, legalBusinessName: true } },
      },
    }),
    prisma.providerTransaction.findMany({
      where: { businessId },
      orderBy: { paymentTimestamp: 'desc' },
      take: 15,
      select: {
        id: true, provider: true, merchantId: true, providerTransactionId: true, paymentTimestamp: true,
        bankReferenceNo: true, amount: true, payerName: true, payerHandle: true, type: true, status: true, payeeIdentifier: true,
      },
    }),
  ]);

  const unitTotalsById = Object.fromEntries(unitGroups.map(row => [row.businessUnitId || 'main', {
    count: row._count,
    amount: Number(row._sum.amount || 0),
  }]));
  const businessUnits = business.businessUnits.map(unit => ({
    ...unit,
    totals: unitTotalsById[unit.id] || { count: 0, amount: 0 },
  }));
  const mainUnitTotals = unitTotalsById.main || { count: 0, amount: 0 };
  const paymentStatusBreakdown = Object.fromEntries(statusGroups.map(row => [row.status, {
    count: row._count,
    amount: Number(row._sum.amount || 0),
  }]));
  const dayBuckets = {};
  for (const payment of dailyPayments) {
    const day = payment.paidAt.toISOString().slice(0, 10);
    if (!dayBuckets[day]) dayBuckets[day] = { day, count: 0, amount: 0 };
    dayBuckets[day].count += 1;
    dayBuckets[day].amount += Number(payment.amount);
  }
  const trend = Object.values(dayBuckets).sort((a, b) => a.day.localeCompare(b.day));

  res.json({
    success: true,
    business: { ...business, businessUnits },
    paymentTotals: { count: paymentTotals._count, amount: Number(paymentTotals._sum.amount || 0) },
    paymentStatusBreakdown,
    mainUnitTotals,
    trend,
    range: { from, to },
    recentPayments,
    recentProviderTransactions,
  });
}));

router.patch('/businesses/:id/suspend', asyncHandler(async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
  const business = await prisma.business.update({
    where: { id: req.params.id },
    data: { suspendedAt: new Date(), suspendedById: req.auth.sub, suspensionReason: reason },
  });
  clearAdminCache();
  logger.warn('Business suspended by admin', { event: 'ADMIN_BUSINESS_SUSPENDED', requestId: req.id, adminId: req.auth.sub, businessId: business.id, reason });
  res.json({ success: true, business });
}));

router.patch('/businesses/:id/unsuspend', asyncHandler(async (req, res) => {
  const business = await prisma.business.update({
    where: { id: req.params.id },
    data: { suspendedAt: null, suspendedById: null, suspensionReason: null },
  });
  clearAdminCache();
  logger.info('Business unsuspended by admin', { event: 'ADMIN_BUSINESS_UNSUSPENDED', requestId: req.id, adminId: req.auth.sub, businessId: business.id });
  res.json({ success: true, business });
}));

router.patch('/businesses/:id/plan', asyncHandler(async (req, res) => {
  const { planId } = z.object({ planId: z.string().min(1).nullable() }).parse(req.body);
  if (planId) {
    const plan = await prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
  }
  const business = await prisma.business.update({ where: { id: req.params.id }, data: { planId }, include: { plan: true } });
  clearAdminCache();
  logger.info('Business plan changed by admin', { event: 'ADMIN_BUSINESS_PLAN_CHANGED', requestId: req.id, adminId: req.auth.sub, businessId: business.id, planId });
  res.json({ success: true, business });
}));

router.patch('/businesses/:id/platform', asyncHandler(async (req, res) => {
  const { isPlatform } = z.object({ isPlatform: z.boolean() }).parse(req.body);
  const business = await prisma.$transaction(async tx => {
    if (isPlatform) await tx.business.updateMany({ where: { isPlatform: true, id: { not: req.params.id } }, data: { isPlatform: false } });
    return tx.business.update({ where: { id: req.params.id }, data: { isPlatform } });
  }, { timeout: 15000 });
  clearAdminCache();
  logger.warn('Business platform designation changed by admin', { event: 'ADMIN_BUSINESS_PLATFORM_CHANGED', requestId: req.id, adminId: req.auth.sub, businessId: business.id, isPlatform });
  res.json({ success: true, business });
}));

router.post('/businesses/:id/business-units', asyncHandler(async (req, res) => {
  const input = businessUnitInput.parse(req.body);
  const business = await prisma.business.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!business) return res.status(404).json({ success: false, message: 'Business not found' });
  const code = input.code.toLowerCase();
  const exists = await prisma.businessUnit.findUnique({ where: { businessId_code: { businessId: business.id, code } } });
  if (exists) return res.status(409).json({ success: false, message: 'A sub-business with this code already exists.' });
  const unit = await prisma.businessUnit.create({
    data: { businessId: business.id, name: input.name, code, description: input.description || null, active: input.active ?? true },
    include: { _count: { select: { payments: true } } },
  });
  clearAdminCache();
  logger.info('Business unit created by admin', { event: 'ADMIN_BUSINESS_UNIT_CREATED', requestId: req.id, adminId: req.auth.sub, businessId: business.id, businessUnitId: unit.id, code: unit.code });
  res.status(201).json({ success: true, unit: { ...unit, totals: { count: 0, amount: 0 } } });
}));

router.patch('/businesses/:id/business-units/:unitId', asyncHandler(async (req, res) => {
  const input = businessUnitInput.partial().parse(req.body);
  const existing = await prisma.businessUnit.findFirst({ where: { id: req.params.unitId, businessId: req.params.id } });
  if (!existing) return res.status(404).json({ success: false, message: 'Sub-business not found' });
  if (input.code) {
    const codeExists = await prisma.businessUnit.findFirst({ where: { businessId: req.params.id, code: input.code.toLowerCase(), id: { not: existing.id } } });
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
    include: { _count: { select: { payments: true } } },
  });
  clearAdminCache();
  logger.info('Business unit updated by admin', { event: 'ADMIN_BUSINESS_UNIT_UPDATED', requestId: req.id, adminId: req.auth.sub, businessId: req.params.id, businessUnitId: unit.id, active: unit.active });
  res.json({ success: true, unit });
}));

// ---- Plans ---------------------------------------------------------------

router.get('/plans', asyncHandler(async (req, res) => {
  const cached = getCached('plans');
  if (cached) return res.json(cached);
  const plans = await prisma.plan.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], include: { _count: { select: { businesses: true } } } });
  const payload = { success: true, plans };
  setCached('plans', payload);
  res.json(payload);
}));

const planInput = z.object({
  name: z.string().min(2).max(80),
  price: z.coerce.number().min(0),
  monthlyPaymentLimit: z.coerce.number().int().min(0).nullable().optional(),
  features: z.array(z.string().min(1).max(200)).max(50).default([]),
  isActive: z.boolean().optional(),
  sortOrder: z.coerce.number().int().optional(),
});

router.post('/plans', asyncHandler(async (req, res) => {
  const input = planInput.parse(req.body);
  const exists = await prisma.plan.findUnique({ where: { name: input.name } });
  if (exists) return res.status(409).json({ success: false, message: 'A plan with this name already exists' });
  const plan = await prisma.plan.create({ data: input });
  clearAdminCache();
  logger.info('Plan created by admin', { event: 'ADMIN_PLAN_CREATED', requestId: req.id, adminId: req.auth.sub, planId: plan.id, name: plan.name });
  res.status(201).json({ success: true, plan });
}));

router.patch('/plans/:id', asyncHandler(async (req, res) => {
  const input = planInput.partial().parse(req.body);
  if (input.name) {
    const exists = await prisma.plan.findFirst({ where: { name: input.name, id: { not: req.params.id } } });
    if (exists) return res.status(409).json({ success: false, message: 'A plan with this name already exists' });
  }
  const plan = await prisma.plan.update({ where: { id: req.params.id }, data: input });
  clearAdminCache();
  logger.info('Plan updated by admin', { event: 'ADMIN_PLAN_UPDATED', requestId: req.id, adminId: req.auth.sub, planId: plan.id });
  res.json({ success: true, plan });
}));

router.patch('/plans/:id/archive', asyncHandler(async (req, res) => {
  const plan = await prisma.plan.update({ where: { id: req.params.id }, data: { isActive: false } });
  clearAdminCache();
  logger.info('Plan archived by admin', { event: 'ADMIN_PLAN_ARCHIVED', requestId: req.id, adminId: req.auth.sub, planId: plan.id });
  res.json({ success: true, plan });
}));

module.exports = router;

function getCached(key) {
  const hit = cache.get(key);
  if (!hit || hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.payload;
}

function setCached(key, payload) {
  cache.set(key, { payload, expiresAt: Date.now() + ADMIN_CACHE_MS });
}

function clearAdminCache() {
  cache.clear();
}
