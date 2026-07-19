const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const config = require('../src/config');

const TEST_PREFIX = '__TEST__';

/** Every throwaway fixture is name-prefixed so a stray leftover (e.g. a crashed test run)
 * is trivially identifiable and safe to sweep up — see cleanupAllTestData(). */
async function createTestBusiness(overrides = {}) {
  return prisma.business.create({ data: { name: `${TEST_PREFIX} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...overrides } });
}

async function createTestUser(businessId, overrides = {}) {
  const { password, ...rest } = overrides;
  const email = rest.email || `${TEST_PREFIX.toLowerCase()}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`;
  return prisma.user.create({ data: {
    name: 'Test User', emailVerifiedAt: new Date(), businessId,
    passwordHash: password ? await bcrypt.hash(password, 4) : undefined,
    ...rest, email,
  }});
}

function dashboardToken(user) {
  return jwt.sign({ sub: user.id, businessId: user.businessId, kind: 'user', role: user.role || 'OWNER', ver: user.tokenVersion ?? 1 }, config.jwtSecret, { expiresIn: '10m' });
}

function clientToken(client) {
  return jwt.sign({ sub: client.id, appId: client.appId, businessId: client.businessId, businessUnitId: client.businessUnitId || undefined, kind: 'client', ver: client.tokenVersion ?? 1 }, config.jwtSecret, { expiresIn: '10m' });
}

async function createTestAdmin(overrides = {}) {
  return prisma.adminUser.create({ data: {
    name: 'Test Admin', email: `${TEST_PREFIX.toLowerCase()}.admin.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`,
    passwordHash: await bcrypt.hash('irrelevant', 4), ...overrides,
  }});
}

function adminToken(admin) {
  return jwt.sign({ sub: admin.id, kind: 'admin', ver: admin.tokenVersion ?? 1 }, config.jwtSecret, { expiresIn: '10m' });
}

async function deleteTestAdmin(adminId) {
  await prisma.adminUser.delete({ where: { id: adminId } }).catch(() => {});
}

async function createTestConnection(businessId, overrides = {}) {
  return prisma.merchantConnection.create({ data: {
    businessId, provider: 'BHARATPE', mobile: '9000000000', encryptedToken: 'fake-token', status: 'ACTIVE',
    merchantId: `${TEST_PREFIX}-MID-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    baseUpiIntent: 'upi://pay?pa=test@fakebank', isDefault: true, ...overrides,
  }});
}

async function createTestPayment(businessId, connectionId, overrides = {}) {
  return prisma.payment.create({ data: {
    publicId: `${TEST_PREFIX}_pay_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    businessId, connectionId, clientOrderId: `${TEST_PREFIX}-ORDER-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    amount: 100, status: 'PENDING', upiIntent: 'upi://pay?pa=test@fakebank', qrImage: Buffer.from(''),
    expiresAt: new Date(Date.now() + 600000), ...overrides,
  }});
}

/** Deletes a business (cascades users/connections/payments/etc). Call in afterEach/afterAll. */
async function deleteTestBusiness(businessId) {
  await prisma.business.delete({ where: { id: businessId } }).catch(() => {});
}

/** Safety net: sweeps up any `__TEST__`-prefixed business older than an hour, in case a
 * crashed run left something behind. Not required for normal green runs. */
async function cleanupStaleTestData() {
  const stale = await prisma.business.findMany({ where: { name: { startsWith: TEST_PREFIX }, createdAt: { lt: new Date(Date.now() - 3600000) } }, select: { id: true } });
  for (const business of stale) await deleteTestBusiness(business.id);
}

module.exports = {
  TEST_PREFIX, createTestBusiness, createTestUser, dashboardToken, clientToken,
  createTestConnection, createTestPayment, deleteTestBusiness, cleanupStaleTestData, prisma,
  createTestAdmin, adminToken, deleteTestAdmin,
};
