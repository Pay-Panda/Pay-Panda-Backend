jest.mock('../src/providers/bharatpe');
jest.mock('../src/services/emailService');
const bharatpe = require('../src/providers/bharatpe');
require('../src/services/emailService'); // mocked so no real SMTP fires on SUCCESS match
const { syncConnection } = require('../src/services/poller');
const { encrypt } = require('../src/lib/crypto');
const {
  prisma, createTestBusiness, createTestConnection, createTestPayment, deleteTestBusiness,
} = require('./helpers');

// This is the highest-risk piece of business logic in the app: deciding whether a bank
// transaction from BharatPe actually corresponds to a specific pending Payment. Getting
// this wrong either leaves a real payment stuck PENDING, or — worse — marks the wrong
// payment as paid. bharatpe.getTransactions is mocked (it's a real external HTTP call);
// everything downstream of it is the real matching code running against the real DB.
describe('syncConnection payment matching', () => {
  let business, connection;

  beforeEach(async () => {
    business = await createTestBusiness();
    connection = await createTestConnection(business.id, { encryptedToken: encrypt('fake-plaintext-token'), merchantId: `__TEST__MID-${Date.now()}` });
    jest.clearAllMocks();
  });

  afterEach(async () => { await deleteTestBusiness(business.id); });

  test('matches a transaction with the exact amount and marks the payment SUCCESS', async () => {
    const payment = await createTestPayment(business.id, connection.id, { amount: 250, clientOrderId: '__TEST__MATCH-1' });
    bharatpe.getTransactions.mockResolvedValue([
      { id: 'txn-1', type: 'PAYMENT_RECV', status: 'SUCCESS', amount: 250, merchantId: connection.merchantId, paymentTimestamp: Date.now(), payerName: 'Someone', payerHandle: 'someone@upi', bankReferenceNo: 'RRN1', internalUtr: 'UTR1' },
    ]);

    await syncConnection(connection);

    const updated = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(updated.status).toBe('SUCCESS');
    expect(updated.providerTransactionId).toBe('txn-1');
  });

  test('does not match a transaction with a different amount, even if only off by a few paise', async () => {
    const payment = await createTestPayment(business.id, connection.id, { amount: 250, clientOrderId: '__TEST__MATCH-2' });
    bharatpe.getTransactions.mockResolvedValue([
      { id: 'txn-2', type: 'PAYMENT_RECV', status: 'SUCCESS', amount: 249.5, merchantId: connection.merchantId, paymentTimestamp: Date.now(), payerName: 'Someone', payerHandle: 'someone@upi' },
    ]);

    await syncConnection(connection);

    const updated = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(updated.status).toBe('PENDING');
  });

  test('when two pending payments share the same amount, the payer-name match disambiguates', async () => {
    const paymentA = await createTestPayment(business.id, connection.id, { amount: 300, clientOrderId: '__TEST__MATCH-3A', customerName: 'Alice Kumar' });
    const paymentB = await createTestPayment(business.id, connection.id, { amount: 300, clientOrderId: '__TEST__MATCH-3B', customerName: 'Bob Singh' });
    bharatpe.getTransactions.mockResolvedValue([
      { id: 'txn-3', type: 'PAYMENT_RECV', status: 'SUCCESS', amount: 300, merchantId: connection.merchantId, paymentTimestamp: Date.now(), payerName: 'Bob Singh', payerHandle: 'bob@upi' },
    ]);

    await syncConnection(connection);

    const [updatedA, updatedB] = await Promise.all([
      prisma.payment.findUnique({ where: { id: paymentA.id } }),
      prisma.payment.findUnique({ where: { id: paymentB.id } }),
    ]);
    expect(updatedB.status).toBe('SUCCESS');
    expect(updatedA.status).toBe('PENDING');
  });

  test('a transaction already claimed by another payment cannot be matched twice', async () => {
    await createTestPayment(business.id, connection.id, { amount: 400, clientOrderId: '__TEST__MATCH-4A', providerTransactionId: 'txn-4', status: 'SUCCESS' });
    const paymentB = await createTestPayment(business.id, connection.id, { amount: 400, clientOrderId: '__TEST__MATCH-4B' });
    bharatpe.getTransactions.mockResolvedValue([
      { id: 'txn-4', type: 'PAYMENT_RECV', status: 'SUCCESS', amount: 400, merchantId: connection.merchantId, paymentTimestamp: Date.now(), payerName: 'X', payerHandle: 'x@upi' },
    ]);

    await syncConnection(connection);

    const updatedB = await prisma.payment.findUnique({ where: { id: paymentB.id } });
    expect(updatedB.status).toBe('PENDING');
  });

  test('non-payment / non-success provider transactions are ignored', async () => {
    const payment = await createTestPayment(business.id, connection.id, { amount: 150, clientOrderId: '__TEST__MATCH-5' });
    bharatpe.getTransactions.mockResolvedValue([
      { id: 'txn-5', type: 'PAYMENT_RECV', status: 'FAILED', amount: 150, merchantId: connection.merchantId, paymentTimestamp: Date.now() },
      { id: 'txn-6', type: 'WITHDRAWAL', status: 'SUCCESS', amount: 150, merchantId: connection.merchantId, paymentTimestamp: Date.now() },
    ]);

    await syncConnection(connection);

    const updated = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(updated.status).toBe('PENDING');
  });
});
