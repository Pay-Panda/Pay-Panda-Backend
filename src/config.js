const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const required = ['DATABASE_URL', 'JWT_SECRET', 'TOKEN_ENCRYPTION_KEY'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing environment variable: ${key}`);
}
if (!/^[a-f\d]{64}$/i.test(process.env.TOKEN_ENCRYPTION_KEY)) {
  throw new Error('TOKEN_ENCRYPTION_KEY must be exactly 64 hexadecimal characters');
}

module.exports = {
  port: Number(process.env.PORT || 4100),
  frontendUrl: process.env.FRONTEND_URL || 'https://www.pay-panda.app',
  publicAppUrl: process.env.PUBLIC_APP_URL || 'https://www.pay-panda.app',
  jwtSecret: process.env.JWT_SECRET,
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '15m',
  userAccessTokenTtl: process.env.USER_ACCESS_TOKEN_TTL || '30m',
  adminAccessTokenTtl: process.env.ADMIN_ACCESS_TOKEN_TTL || '4h',
  encryptionKey: Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'hex'),
  paymentExpiryMinutes: Number(process.env.PAYMENT_EXPIRY_MINUTES || 10),
  liveVerifyThrottleMs: Math.max(5000, Number(process.env.LIVE_VERIFY_THROTTLE_MS || 5000)),
  reconciliationIntervalMs: Math.max(300000, Number(process.env.RECONCILIATION_INTERVAL_MS || 1800000)),
  smtp: process.env.SMTP_HOST ? {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || process.env.SMTP_PASS } : undefined,
  } : null,
  emailFrom: process.env.EMAIL_FROM || process.env.SMTP_FROM || 'Pay-Panda <no-reply@pay-panda.local>',
  emailVerificationHours: Number(process.env.EMAIL_VERIFICATION_HOURS || 24),
  passwordResetMinutes: Number(process.env.PASSWORD_RESET_MINUTES || 30),
  loginOtpMinutes: Number(process.env.LOGIN_OTP_MINUTES || 10),
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  superAdmin: {
    id: 'env-super-admin',
    email: process.env.SUPER_ADMIN_EMAIL?.toLowerCase() || '',
    password: process.env.SUPER_ADMIN_PASSWORD || '',
    name: process.env.SUPER_ADMIN_NAME || 'Super Admin',
    credentialVersion: crypto.createHash('sha256')
      .update(`${process.env.SUPER_ADMIN_EMAIL?.toLowerCase() || ''}:${process.env.SUPER_ADMIN_PASSWORD || ''}:${process.env.JWT_SECRET}`)
      .digest('hex'),
  },
};
