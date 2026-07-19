jest.mock('axios');
jest.mock('../src/providers/bharatpe');
jest.mock('../src/services/emailService');
const axios = require('axios');
const bharatpe = require('../src/providers/bharatpe');
const request = require('supertest');
const app = require('../src/app');
const { encrypt } = require('../src/lib/crypto');
const { syncConnection } = require('../src/services/poller');
const {
  prisma, createTestBusiness, createTestUser, dashboardToken, createTestConnection, createTestPayment,
  deleteTestBusiness, createTestAdmin, adminToken, deleteTestAdmin,
} = require('./helpers');

describe('Webhooks', () => {
  let business, user, token;

  beforeEach(async () => {
    business = await createTestBusiness();
    user = await createTestUser(business.id);
    token = dashboardToken(user);
    jest.clearAllMocks();
  });

  afterEach(async () => { await deleteTestBusiness(business.id); });

  test('setting a webhook URL auto-generates a secret', async () => {
    const res = await request(app).patch('/api/dashboard/webhook').set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://example.com/hook' });
    expect(res.status).toBe(200);
    expect(res.body.webhook.url).toBe('https://example.com/hook');
    expect(res.body.webhook.secretConfigured).toBe(true);
  });

  test('regenerating the secret changes its value', async () => {
    await request(app).patch('/api/dashboard/webhook').set('Authorization', `Bearer ${token}`).send({ url: 'https://example.com/hook' });
    const before = (await prisma.business.findUnique({ where: { id: business.id } })).webhookSecret;
    const res = await request(app).post('/api/dashboard/webhook/regenerate-secret').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.webhook.secret).not.toBe(before);
  });

  test('test webhook fails cleanly when no URL is configured', async () => {
    const res = await request(app).post('/api/dashboard/webhook/test').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  test('test webhook posts a signed payload to the configured URL', async () => {
    axios.post.mockResolvedValue({ status: 200, data: 'ok' });
    await request(app).patch('/api/dashboard/webhook').set('Authorization', `Bearer ${token}`).send({ url: 'https://example.com/hook' });
    const res = await request(app).post('/api/dashboard/webhook/test').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.result.ok).toBe(true);
    expect(axios.post).toHaveBeenCalledWith('https://example.com/hook', expect.anything(), expect.objectContaining({
      headers: expect.objectContaining({ 'X-Pay-Panda-Event': 'webhook.test' }),
    }));
  });

  test('a SUCCESS payment match queues and delivers a webhook', async () => {
    axios.post.mockResolvedValue({ status: 200, data: 'ok' });
    await request(app).patch('/api/dashboard/webhook').set('Authorization', `Bearer ${token}`).send({ url: 'https://example.com/hook' });
    const connection = await createTestConnection(business.id, { encryptedToken: encrypt('fake'), merchantId: `__TEST__WH-${Date.now()}` });
    const payment = await createTestPayment(business.id, connection.id, { amount: 500, clientOrderId: '__TEST__WH-ORDER-1' });
    bharatpe.getTransactions.mockResolvedValue([
      { id: 'wh-txn-1', type: 'PAYMENT_RECV', status: 'SUCCESS', amount: 500, merchantId: connection.merchantId, paymentTimestamp: Date.now(), payerName: 'Someone', payerHandle: 'someone@upi' },
    ]);
    await syncConnection(connection);
    await new Promise(resolve => setTimeout(resolve, 300));
    const delivery = await prisma.webhookDelivery.findFirst({ where: { paymentId: payment.id } });
    expect(delivery).toBeTruthy();
    expect(delivery.event).toBe('payment.success');
    expect(delivery.status).toBe('SUCCESS');
  });
});

describe('Refunds', () => {
  let business, user, token, connection;

  beforeEach(async () => {
    business = await createTestBusiness();
    user = await createTestUser(business.id);
    token = dashboardToken(user);
    connection = await createTestConnection(business.id);
  });

  afterEach(async () => { await deleteTestBusiness(business.id); });

  test('refund can only be requested on a SUCCESS payment', async () => {
    const pending = await createTestPayment(business.id, connection.id, { status: 'PENDING' });
    const res = await request(app).post(`/api/dashboard/payments/${pending.id}/refund-request`).set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Customer asked for a refund' });
    expect(res.status).toBe(400);
  });

  test('full refund lifecycle: request then complete', async () => {
    const paid = await createTestPayment(business.id, connection.id, { status: 'SUCCESS', paidAt: new Date() });
    const requestRes = await request(app).post(`/api/dashboard/payments/${paid.id}/refund-request`).set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Duplicate order' });
    expect(requestRes.status).toBe(200);
    expect(requestRes.body.payment.refundStatus).toBe('REQUESTED');

    const dupe = await request(app).post(`/api/dashboard/payments/${paid.id}/refund-request`).set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Duplicate order' });
    expect(dupe.status).toBe(409);

    const completeRes = await request(app).post(`/api/dashboard/payments/${paid.id}/refund-complete`).set('Authorization', `Bearer ${token}`)
      .send({ reference: 'UTR123456789' });
    expect(completeRes.status).toBe(200);
    expect(completeRes.body.payment.refundStatus).toBe('REFUNDED');
    expect(completeRes.body.payment.refundReference).toBe('UTR123456789');
  });
});

describe('Complaints', () => {
  let business, user, token, connection, payment, admin, adminTok;

  beforeEach(async () => {
    business = await createTestBusiness();
    user = await createTestUser(business.id);
    token = dashboardToken(user);
    connection = await createTestConnection(business.id);
    payment = await createTestPayment(business.id, connection.id, { status: 'SUCCESS' });
    admin = await createTestAdmin();
    adminTok = adminToken(admin);
  });

  afterEach(async () => {
    await deleteTestBusiness(business.id);
    await deleteTestAdmin(admin.id);
  });

  test('a customer can file a complaint without logging in, using only the payment ID', async () => {
    const res = await request(app).post(`/api/public/payments/${payment.publicId}/complaints`)
      .send({ message: 'Money was deducted but order was not fulfilled', filerContact: 'customer@example.com' });
    expect(res.status).toBe(201);
    expect(res.body.complaint.status).toBe('OPEN');

    const stored = await prisma.paymentComplaint.findUnique({ where: { id: res.body.complaint.id } });
    expect(stored.filedBy).toBe('CUSTOMER');
    expect(stored.businessId).toBe(business.id);
  });

  test('filing a complaint against an unknown payment ID is rejected', async () => {
    const res = await request(app).post('/api/public/payments/__TEST__does-not-exist/complaints').send({ message: 'Anything at all here' });
    expect(res.status).toBe(404);
  });

  test('a business can file and list complaints on its own dashboard', async () => {
    const fileRes = await request(app).post(`/api/dashboard/payments/${payment.id}/complaints`).set('Authorization', `Bearer ${token}`)
      .send({ message: 'Customer is disputing this charge' });
    expect(fileRes.status).toBe(201);

    const listRes = await request(app).get('/api/dashboard/complaints').set('Authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.complaints.length).toBe(1);
    expect(listRes.body.complaints[0].filedBy).toBe('BUSINESS');
  });

  test('admin can view and resolve a complaint, including cross-business visibility', async () => {
    const customerComplaint = await request(app).post(`/api/public/payments/${payment.publicId}/complaints`)
      .send({ message: 'Refund never arrived' });
    const complaintId = customerComplaint.body.complaint.id;

    const listRes = await request(app).get('/api/admin/complaints').set('Authorization', `Bearer ${adminTok}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.complaints.some(item => item.id === complaintId)).toBe(true);

    const detailRes = await request(app).get(`/api/admin/complaints/${complaintId}`).set('Authorization', `Bearer ${adminTok}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.complaint.payment).toBeTruthy();

    const resolveRes = await request(app).patch(`/api/admin/complaints/${complaintId}`).set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'RESOLVED', adminNotes: 'Confirmed refund sent manually by business' });
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.complaint.status).toBe('RESOLVED');
  });

  test('a non-admin dashboard token cannot access the admin complaints list', async () => {
    const res = await request(app).get('/api/admin/complaints').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});
