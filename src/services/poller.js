const prisma = require('../db');
const config = require('../config');
const { decrypt } = require('../lib/crypto');
const bharatpe = require('../providers/bharatpe');
const { computePlatformFee } = require('./subscriptionService');
const { logger, safeError } = require('../lib/logger');

const liveChecks = new Map();
let reconciliationRunning = false;
const normalizeName = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function expirePendingPayments() {
  const expired = await prisma.payment.updateMany({ where: { status: 'PENDING', expiresAt: { lte: new Date() } }, data: { status: 'EXPIRED' } });
  if (expired.count) logger.warn('Expired stale payment sessions', { event: 'PAYMENTS_EXPIRED', count: expired.count });
  return expired.count;
}

async function syncPublicPayment(publicId) {
  const payment = await prisma.payment.findUnique({ where: { publicId }, include: { connection: true } });
  if (!payment || payment.status !== 'PENDING' || payment.expiresAt <= new Date() || payment.connection.status !== 'ACTIVE') return;
  const key = payment.connectionId;
  const current = liveChecks.get(key);
  if (current?.promise) return current.promise;
  if (current && Date.now() - current.checkedAt < config.liveVerifyThrottleMs) return;
  const promise = syncConnection(payment.connection, { paymentId: payment.id, reason: 'ACTIVE_CHECKOUT' })
    .catch(error => logger.error('Active checkout verification failed', { event: 'LIVE_VERIFY_ERROR', connectionId: key, paymentId: publicId, ...safeError(error) }))
    .finally(() => liveChecks.set(key, { checkedAt: Date.now(), promise: null }));
  liveChecks.set(key, { checkedAt: current?.checkedAt || 0, promise });
  return promise;
}

async function syncConnection(connection, { paymentId, windowStart, reason = 'MANUAL' } = {}) {
  const now = new Date();
  const pending = await prisma.payment.findMany({
    where: {
      connectionId: connection.id, status: 'PENDING', expiresAt: { gt: now },
      ...(paymentId ? { id: paymentId } : {}),
      ...(windowStart ? { createdAt: { gte: windowStart } } : {}),
    },
    orderBy: { createdAt: 'asc' }, include: { business: true },
  });
  if (!pending.length) return;
  logger.debug('Checking eligible payments for merchant', { event: 'POLL_START', reason, connectionId: connection.id, merchantId: connection.merchantId, pendingCount: pending.length });
  const startMs = Math.max(windowStart?.getTime() || 0, pending[0].createdAt.getTime());
  const txns = await bharatpe.getTransactions(decrypt(connection.encryptedToken), {
    merchantId: connection.merchantId, startMs, endMs: now.getTime(), pageSize: 100,
  });
  logger.debug('Provider transactions received', { event: 'POLL_RESULT', reason, connectionId: connection.id, merchantId: connection.merchantId, transactionCount: txns.length });

  for (const txn of txns) {
    if (txn.type !== 'PAYMENT_RECV' || txn.status !== 'SUCCESS') continue;
    await prisma.providerTransaction.upsert({
      where: { providerTransactionId: String(txn.id) }, update: {},
      create: {
        businessId: connection.businessId, provider: 'BHARATPE', providerTransactionId: String(txn.id),
        merchantId: String(txn.merchantId), paymentTimestamp: new Date(Number(txn.paymentTimestamp)),
        internalUtr: txn.internalUtr, bankReferenceNo: txn.bankReferenceNo, amount: txn.amount,
        payerName: txn.payerName, payerHandle: txn.payerHandle, type: txn.type, status: txn.status,
        payeeIdentifier: txn.payeeIdentifier, rawData: txn,
      },
    });
  }
  const claimed = new Set((await prisma.payment.findMany({
    where: { providerTransactionId: { in: txns.map(txn => String(txn.id)) } }, select: { providerTransactionId: true },
  })).map(item => item.providerTransactionId));

  for (const payment of pending) {
    const candidates = txns.filter(txn => !claimed.has(String(txn.id)) && txn.type === 'PAYMENT_RECV' && txn.status === 'SUCCESS' && Number(txn.paymentTimestamp) >= payment.createdAt.getTime() && Number(txn.paymentTimestamp) <= payment.expiresAt.getTime() && Math.abs(Number(txn.amount) - Number(payment.amount)) < 0.001);
    if (!candidates.length) continue;
    const expectedName = normalizeName(payment.customerName);
    const nameMatch = expectedName && candidates.find(txn => { const payer = normalizeName(txn.payerName); return payer.includes(expectedName) || expectedName.includes(payer); });
    const match = nameMatch || candidates.sort((a, b) => a.paymentTimestamp - b.paymentTimestamp)[0];
    try {
      const paidAt = new Date(Number(match.paymentTimestamp));
      const platformFeeAmount = await computePlatformFee(payment.businessId, paidAt);
      await prisma.payment.update({ where: { id: payment.id }, data: {
        status: 'SUCCESS', providerTransactionId: String(match.id), bankReferenceNo: match.bankReferenceNo,
        internalUtr: match.internalUtr, payerName: match.payerName, payerHandle: match.payerHandle,
        paidAt, lastCheckedAt: now, platformFeeAmount,
      }});
      logger.info('Payment matched and confirmed', { event: 'PAYMENT_MATCHED', reason, businessId: payment.businessId, paymentId: payment.publicId, orderId: payment.clientOrderId, providerTransactionId: String(match.id), amount: Number(match.amount), bankReferenceNo: match.bankReferenceNo, payerName: match.payerName, payerHandle: match.payerHandle });
      claimed.add(String(match.id));
    } catch (error) { if (error.code !== 'P2002') throw error; }
  }
  await prisma.payment.updateMany({ where: { id: { in: pending.map(item => item.id) }, status: 'PENDING' }, data: { lastCheckedAt: now } });
}

async function reconcileRecentPayments() {
  if (reconciliationRunning) return;
  reconciliationRunning = true;
  const windowStart = new Date(Date.now() - 60 * 60 * 1000);
  logger.info('Starting 30-minute payment reconciliation', { event: 'RECONCILIATION_START', windowStart });
  try {
    await expirePendingPayments();
    const connections = await prisma.merchantConnection.findMany({ where: {
      status: 'ACTIVE', payments: { some: { status: 'PENDING', createdAt: { gte: windowStart } } },
    }});
    for (const connection of connections) {
      try { await syncConnection(connection, { windowStart, reason: '30_MIN_RECONCILIATION' }); }
      catch (error) { logger.error('Merchant reconciliation failed', { event: 'RECONCILIATION_ERROR', connectionId: connection.id, merchantId: connection.merchantId, ...safeError(error) }); }
    }
    logger.info('Payment reconciliation completed', { event: 'RECONCILIATION_DONE', connectionCount: connections.length });
  } finally { reconciliationRunning = false; }
}

module.exports = { expirePendingPayments, reconcileRecentPayments, syncConnection, syncPublicPayment };
