const express = require('express');
const { z } = require('zod');
const prisma = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const { requireAdminAuth } = require('../../middleware/auth');
const { logger } = require('../../lib/logger');

const router = express.Router();
router.use(requireAdminAuth);
const ADMIN_CACHE_MS = 15000;
const cache = new Map();

// ---- Insights ----------------------------------------------------------

router.get('/insights/overview', asyncHandler(async (req, res) => {
  const cached = getCached('overview');
  if (cached) return res.json(cached);
  const since30 = new Date(Date.now() - 30 * 86400000);
  const [businessCount, activeCount, suspendedCount, userCount, paymentTotals, planGroups, recentBusinesses, dailyPayments] = await Promise.all([
    prisma.business.count(),
    prisma.business.count({ where: { suspendedAt: null } }),
    prisma.business.count({ where: { suspendedAt: { not: null } } }),
    prisma.user.count(),
    prisma.payment.aggregate({ where: { status: 'SUCCESS' }, _sum: { amount: true }, _count: true }),
    prisma.business.groupBy({ by: ['planId'], _count: true }),
    prisma.business.findMany({ orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, name: true, createdAt: true, suspendedAt: true } }),
    prisma.payment.findMany({ where: { status: 'SUCCESS', createdAt: { gte: since30 } }, select: { amount: true, createdAt: true } }),
  ]);

  const plans = await prisma.plan.findMany({ select: { id: true, name: true } });
  const planNameById = Object.fromEntries(plans.map(plan => [plan.id, plan.name]));
  const planDistribution = planGroups.map(row => ({ planId: row.planId, planName: row.planId ? (planNameById[row.planId] || 'Unknown') : 'No plan', count: row._count }));

  const dayBuckets = {};
  for (const payment of dailyPayments) {
    const day = payment.createdAt.toISOString().slice(0, 10);
    if (!dayBuckets[day]) dayBuckets[day] = { day, count: 0, amount: 0 };
    dayBuckets[day].count += 1;
    dayBuckets[day].amount += Number(payment.amount);
  }
  const trend = Object.values(dayBuckets).sort((a, b) => a.day.localeCompare(b.day));

  const payload = {
    success: true,
    overview: {
      businesses: { total: businessCount, active: activeCount, suspended: suspendedCount },
      users: userCount,
      lifetimePayments: { count: paymentTotals._count, amount: Number(paymentTotals._sum.amount || 0) },
      planDistribution,
      recentBusinesses,
      trend,
    },
  };
  setCached('overview', payload);
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
  const business = await prisma.business.findUnique({
    where: { id: req.params.id },
    include: {
      plan: true,
      users: { select: { id: true, name: true, email: true, role: true, emailVerifiedAt: true, createdAt: true } },
      connections: { select: { id: true, provider: true, label: true, status: true, merchantName: true, createdAt: true } },
      _count: { select: { payments: true } },
    },
  });
  if (!business) return res.status(404).json({ success: false, message: 'Business not found' });
  const paymentTotals = await prisma.payment.aggregate({ where: { businessId: business.id, status: 'SUCCESS' }, _sum: { amount: true }, _count: true });
  res.json({ success: true, business, paymentTotals: { count: paymentTotals._count, amount: Number(paymentTotals._sum.amount || 0) } });
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
