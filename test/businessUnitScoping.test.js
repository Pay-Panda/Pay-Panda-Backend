const request = require('supertest');
const app = require('../src/app');
const bcrypt = require('bcryptjs');
const {
  prisma, createTestBusiness, createTestConnection, deleteTestBusiness, clientToken,
} = require('./helpers');

// Sub-business (BusinessUnit) scoping is a hard security boundary: an app credential
// created for one sub-business must never be able to create, read, or verify a payment
// belonging to a different sub-business (or the general/unscoped bucket) of the same
// business — this is the core guarantee the whole feature promises to merchants.
describe('App credential sub-business scoping', () => {
  let business, connection, unitA, unitB, scopedClientA, generalClient;

  beforeAll(async () => {
    business = await createTestBusiness();
    connection = await createTestConnection(business.id);
    unitA = await prisma.businessUnit.create({ data: { businessId: business.id, name: 'Unit A', code: '__test-unit-a' } });
    unitB = await prisma.businessUnit.create({ data: { businessId: business.id, name: 'Unit B', code: '__test-unit-b' } });
    scopedClientA = await prisma.apiClient.create({ data: {
      businessId: business.id, businessUnitId: unitA.id, name: 'Scoped A', appId: `__TEST__scopedA_${Date.now()}`, secretHash: await bcrypt.hash('x', 4),
    }});
    generalClient = await prisma.apiClient.create({ data: {
      businessId: business.id, name: 'General', appId: `__TEST__general_${Date.now()}`, secretHash: await bcrypt.hash('x', 4),
    }});
  });

  afterAll(async () => { await deleteTestBusiness(business.id); });

  test('scoped client auto-attributes a created payment to its own sub-business', async () => {
    const token = clientToken(scopedClientA);
    const res = await request(app).post('/api/v1/payments').set('Authorization', `Bearer ${token}`)
      .send({ order_id: '__TEST__BU-ORDER-1', amount: 100 });
    expect(res.status).toBe(201);
    expect(res.body.payment.business_unit.id).toBe(unitA.id);
  });

  test('scoped client is rejected when explicitly targeting a different sub-business by id', async () => {
    const token = clientToken(scopedClientA);
    const res = await request(app).post('/api/v1/payments').set('Authorization', `Bearer ${token}`)
      .send({ order_id: '__TEST__BU-ORDER-2', amount: 100, business_unit_id: unitB.id });
    expect(res.status).toBe(400);
  });

  test('scoped client is rejected when targeting a different sub-business by code', async () => {
    const token = clientToken(scopedClientA);
    const res = await request(app).post('/api/v1/payments').set('Authorization', `Bearer ${token}`)
      .send({ order_id: '__TEST__BU-ORDER-3', amount: 100, business_unit_code: unitB.code });
    expect(res.status).toBe(400);
  });

  test('scoped client cannot read a payment belonging to a different sub-business', async () => {
    const generalToken = clientToken(generalClient);
    await request(app).post('/api/v1/payments').set('Authorization', `Bearer ${generalToken}`)
      .send({ order_id: '__TEST__BU-ORDER-B1', amount: 250, business_unit_id: unitB.id });

    const scopedToken = clientToken(scopedClientA);
    const res = await request(app).get('/api/v1/payments/__TEST__BU-ORDER-B1').set('Authorization', `Bearer ${scopedToken}`);
    expect(res.status).toBe(404);
  });

  test('unscoped (general) client can read across all sub-businesses', async () => {
    const generalToken = clientToken(generalClient);
    const res = await request(app).get('/api/v1/payments/__TEST__BU-ORDER-B1').set('Authorization', `Bearer ${generalToken}`);
    expect(res.status).toBe(200);
  });
});
