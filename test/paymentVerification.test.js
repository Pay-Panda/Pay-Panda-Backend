const request = require('supertest');
const app = require('../src/app');
const bcrypt = require('bcryptjs');
const {
  prisma, createTestBusiness, createTestConnection, createTestPayment, deleteTestBusiness, clientToken,
} = require('./helpers');

// This is the strict amount cross-check added specifically because some UPI apps let the
// payer edit the amount before paying — the highest-value regression to guard against,
// since a silent regression here would mean a merchant treats a short-paid order as fully
// paid. Every case is exercised against the real /v1/payments/verify endpoint.
describe('POST /v1/payments/verify — strict amount cross-check', () => {
  let business, connection, apiClient, token, payment;

  beforeAll(async () => {
    business = await createTestBusiness();
    connection = await createTestConnection(business.id);
    apiClient = await prisma.apiClient.create({ data: {
      businessId: business.id, name: 'Test Client', appId: `__TEST__app_${Date.now()}`, secretHash: await bcrypt.hash('unused', 4),
    }});
    token = clientToken(apiClient);
    payment = await createTestPayment(business.id, connection.id, {
      clientOrderId: '__TEST__VERIFY-ORDER', amount: 499.00, status: 'SUCCESS',
      customerMobile: '9876543210', paidAt: new Date(),
    });
  });

  afterAll(async () => { await deleteTestBusiness(business.id); });

  test('exact amount match verifies successfully', async () => {
    const res = await request(app).post('/api/v1/payments/verify').set('Authorization', `Bearer ${token}`)
      .send({ order_id: payment.clientOrderId, amount: 499.00 });
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
  });

  test('one paisa short is rejected as AMOUNT_MISMATCH even though status is SUCCESS', async () => {
    const res = await request(app).post('/api/v1/payments/verify').set('Authorization', `Bearer ${token}`)
      .send({ order_id: payment.clientOrderId, amount: 498.99 });
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(false);
    expect(res.body.code).toBe('AMOUNT_MISMATCH');
  });

  test('one paisa over is also rejected', async () => {
    const res = await request(app).post('/api/v1/payments/verify').set('Authorization', `Bearer ${token}`)
      .send({ order_id: payment.clientOrderId, amount: 499.01 });
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(false);
    expect(res.body.code).toBe('AMOUNT_MISMATCH');
  });

  test('floating-point rounding noise at the paisa boundary does not false-positive', async () => {
    const res = await request(app).post('/api/v1/payments/verify').set('Authorization', `Bearer ${token}`)
      .send({ order_id: payment.clientOrderId, amount: 499.0000001 });
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
  });

  test('mobile mismatch is informational only and never blocks verified', async () => {
    const res = await request(app).post('/api/v1/payments/verify').set('Authorization', `Bearer ${token}`)
      .send({ order_id: payment.clientOrderId, amount: 499.00, customer_mobile: '1111111111' });
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.mobileMatched).toBe(false);
  });

  test('matching mobile reports mobileMatched true', async () => {
    const res = await request(app).post('/api/v1/payments/verify').set('Authorization', `Bearer ${token}`)
      .send({ order_id: payment.clientOrderId, amount: 499.00, customer_mobile: '9876543210' });
    expect(res.body.mobileMatched).toBe(true);
  });

  test('unauthenticated request is rejected', async () => {
    const res = await request(app).post('/api/v1/payments/verify').send({ order_id: payment.clientOrderId });
    expect(res.status).toBe(401);
  });

  test('another business\'s OAuth client cannot verify this payment', async () => {
    const otherBusiness = await createTestBusiness();
    const otherClient = await prisma.apiClient.create({ data: {
      businessId: otherBusiness.id, name: 'Other', appId: `__TEST__app_other_${Date.now()}`, secretHash: await bcrypt.hash('unused', 4),
    }});
    const otherToken = clientToken(otherClient);
    const res = await request(app).post('/api/v1/payments/verify').set('Authorization', `Bearer ${otherToken}`)
      .send({ order_id: payment.clientOrderId });
    expect(res.status).toBe(404);
    await deleteTestBusiness(otherBusiness.id);
  });
});
