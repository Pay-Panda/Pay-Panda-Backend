jest.mock('../src/services/emailService');
const emailService = require('../src/services/emailService');
const request = require('supertest');
const app = require('../src/app');
const { prisma, deleteTestBusiness } = require('./helpers');

emailService.sendActivationEmail.mockImplementation(() => Promise.resolve({ delivered: true }));
emailService.sendPasswordResetEmail.mockImplementation(() => Promise.resolve({ delivered: true }));
emailService.sendLoginOtpEmail.mockImplementation(() => Promise.resolve({ delivered: true }));
emailService.sendSecurityAlertEmail.mockImplementation(() => Promise.resolve({ delivered: true }));
emailService.sendPaymentReceiptEmail.mockImplementation(() => Promise.resolve({ delivered: true }));
emailService.sendPaymentReceivedEmail.mockImplementation(() => Promise.resolve({ delivered: true }));

function tokenFromUrl(url) { return new URL(url).searchParams.get('token'); }

// Full email+OTP account lifecycle, exercised end to end through the real HTTP routes —
// email delivery itself is mocked (so no real SMTP happens in CI), but every other line of
// business logic (hashing, expiry, token verification, session revocation) is real.
describe('Auth flow: register -> activate -> login OTP -> change password', () => {
  const email = `__test__.authflow.${Date.now()}@example.com`;
  const password = 'TestPass123!';
  let businessId;

  afterAll(async () => { if (businessId) await deleteTestBusiness(businessId); });

  test('register creates an unverified account and sends an activation email', async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Test Owner', businessName: '__TEST__ Auth Flow Biz', email, mobile: '+919876500001', password,
    });
    expect(res.status).toBe(201);
    expect(emailService.sendActivationEmail).toHaveBeenCalledTimes(1);
    const user = await prisma.user.findUnique({ where: { email } });
    businessId = user.businessId;
    expect(user.emailVerifiedAt).toBeNull();
  });

  test('rejects login before activation', async () => {
    const res = await request(app).post('/api/auth/login').send({ email, password });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_NOT_ACTIVATED');
  });

  test('activation link works with the real emailed token and rejects a wrong password', async () => {
    const { activationUrl } = emailService.sendActivationEmail.mock.calls[0][0];
    const token = tokenFromUrl(activationUrl);

    const wrongPassword = await request(app).post('/api/auth/activate').send({ token, password: 'WrongPassword1!' });
    expect(wrongPassword.status).toBe(401);

    const activated = await request(app).post('/api/auth/activate').send({ token, password });
    expect(activated.status).toBe(200);
  });

  test('login now issues an OTP challenge instead of a token', async () => {
    const res = await request(app).post('/api/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    expect(res.body.requiresOtp).toBe(true);
    expect(emailService.sendLoginOtpEmail).toHaveBeenCalled();
  });

  test('wrong OTP is rejected, correct OTP from the real emailed value logs in', async () => {
    const loginRes = await request(app).post('/api/auth/login').send({ email, password });
    const { challenge } = loginRes.body;
    const otp = emailService.sendLoginOtpEmail.mock.calls.at(-1)[0].otp;

    const wrong = await request(app).post('/api/auth/verify-login-otp').send({ challenge, otp: '000000' });
    expect(wrong.status).toBe(401);

    const right = await request(app).post('/api/auth/verify-login-otp').send({ challenge, otp });
    expect(right.status).toBe(200);
    expect(right.body.token).toBeDefined();
  });

  test('change-password revokes the old session', async () => {
    const loginRes = await request(app).post('/api/auth/login').send({ email, password });
    const otp = emailService.sendLoginOtpEmail.mock.calls.at(-1)[0].otp;
    const verifyRes = await request(app).post('/api/auth/verify-login-otp').send({ challenge: loginRes.body.challenge, otp });
    const oldToken = verifyRes.body.token;

    const changeRes = await request(app).post('/api/auth/change-password').set('Authorization', `Bearer ${oldToken}`)
      .send({ currentPassword: password, newPassword: 'NewPass456!', confirmPassword: 'NewPass456!' });
    expect(changeRes.status).toBe(200);

    const meRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${oldToken}`);
    expect(meRes.status).toBe(401);
  });
});
