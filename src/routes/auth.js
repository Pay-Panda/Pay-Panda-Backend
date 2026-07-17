const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { z } = require('zod');
const prisma = require('../db');
const config = require('../config');
const asyncHandler = require('../lib/asyncHandler');
const { requireDashboardAuth } = require('../middleware/auth');
const { isStrongPassword, passwordMessage } = require('../lib/password');
const { sendActivationEmail, sendPasswordResetEmail, sendLoginOtpEmail } = require('../services/emailService');
const { logger, safeError } = require('../lib/logger');
const { buildFrontendUrl } = require('../lib/frontendUrl');

const router = express.Router();
const authToken = user => jwt.sign({ sub: user.id, businessId: user.businessId, kind: 'user', role: user.role, ver: user.tokenVersion }, config.jwtSecret, { expiresIn: config.userAccessTokenTtl });

// Email delivery can fail transiently (SMTP outage, DNS, etc). For informational emails
// (activation, password reset) we still let the user proceed, falling back to the same
// "SMTP not configured" development-link shape rather than a hard 500.
async function safeDeliver(sendPromise, fallbackUrl) {
  try { return await sendPromise; }
  catch { return { delivered: false, developmentUrl: fallbackUrl }; }
}

router.post('/register', asyncHandler(async (req, res) => {
  const input = z.object({
    name: z.string().min(2).max(80), businessName: z.string().min(2).max(120),
    email: z.email(), mobile: z.string().regex(/^(?:\+91\d{10}|\+(?!91)[1-9]\d{7,14})$/, 'For India, select +91 and enter exactly 10 digits.'), password: z.string().min(6).max(100),
  }).parse(req.body);
  if (!isStrongPassword(input.password)) return res.status(400).json({ success: false, message: passwordMessage });
  const exists = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
  if (exists) return res.status(409).json({ success: false, message: 'Email is already registered' });
  const verificationToken = crypto.randomBytes(32).toString('base64url');
  const verificationHash = hashToken(verificationToken);
  const passwordHash = await bcrypt.hash(input.password, 12);
  const user = await prisma.$transaction(async tx => {
    const business = await tx.business.create({ data: { name: input.businessName, supportEmail: input.email.toLowerCase() } });
    return tx.user.create({ data: {
      name: input.name, email: input.email.toLowerCase(), mobile: input.mobile,
      passwordHash, businessId: business.id,
      emailVerificationTokenHash: verificationHash,
      emailVerificationExpiresAt: new Date(Date.now() + config.emailVerificationHours * 3600000),
    }, include: { business: true } });
  }, { timeout: 15000 });
  const activationUrl = buildFrontendUrl(req, '/activate', verificationToken);
  const delivery = await safeDeliver(sendActivationEmail({ email: user.email, name: user.name, activationUrl }), activationUrl);
  logger.info('User registered; activation required', { event: 'USER_REGISTERED', requestId: req.id, userId: user.id, businessId: user.businessId, email: maskEmail(user.email), emailDelivered: delivery.delivered });
  res.status(201).json({
    success: true,
    message: delivery.delivered ? 'Check your email for the activation link.' : 'Account created. The activation email could not be sent right now; use the development activation link below.',
    ...(process.env.NODE_ENV !== 'production' && delivery.developmentUrl ? { developmentActivationUrl: delivery.developmentUrl } : {}),
  });
}));

router.get('/activation/:token', asyncHandler(async (req, res) => {
  const user = await prisma.user.findFirst({ where: { emailVerificationTokenHash: hashToken(req.params.token) }, select: { email: true, emailVerifiedAt: true, emailVerificationExpiresAt: true } });
  if (!user) return res.status(404).json({ success: false, message: 'Activation link is invalid or has already been used.' });
  if (user.emailVerificationExpiresAt < new Date()) return res.status(410).json({ success: false, message: 'Activation link has expired.' });
  res.json({ success: true, email: maskEmail(user.email) });
}));

router.post('/activate', asyncHandler(async (req, res) => {
  const input = z.object({ token: z.string().min(20), password: z.string().min(1) }).parse(req.body);
  const user = await prisma.user.findFirst({ where: { emailVerificationTokenHash: hashToken(input.token) }, include: { business: true } });
  if (!user) return res.status(404).json({ success: false, message: 'Activation link is invalid or has already been used.' });
  if (user.emailVerificationExpiresAt < new Date()) return res.status(410).json({ success: false, message: 'Activation link has expired.' });
  if (!await bcrypt.compare(input.password, user.passwordHash)) return res.status(401).json({ success: false, message: 'Password does not match the password used during signup.' });
  const activated = await prisma.user.update({ where: { id: user.id }, data: {
    emailVerifiedAt: new Date(), emailVerificationTokenHash: null, emailVerificationExpiresAt: null,
  }, include: { business: true } });
  logger.info('User account activated', { event: 'ACCOUNT_ACTIVATED', requestId: req.id, userId: activated.id, businessId: activated.businessId, email: maskEmail(activated.email) });
  res.json({ success: true, message: 'Account activated successfully. Sign in to receive your email OTP.' });
}));

router.post('/resend-activation', asyncHandler(async (req, res) => {
  const { email } = z.object({ email: z.email() }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || user.emailVerifiedAt) return res.json({ success: true, message: 'If activation is required, a new link has been sent.' });
  const token = crypto.randomBytes(32).toString('base64url');
  await prisma.user.update({ where: { id: user.id }, data: {
    emailVerificationTokenHash: hashToken(token), emailVerificationExpiresAt: new Date(Date.now() + config.emailVerificationHours * 3600000),
  }});
  const resendActivationUrl = buildFrontendUrl(req, '/activate', token);
  const delivery = await safeDeliver(sendActivationEmail({ email: user.email, name: user.name, activationUrl: resendActivationUrl }), resendActivationUrl);
  logger.info('Activation email reissued', { event: 'ACTIVATION_RESENT', requestId: req.id, userId: user.id, businessId: user.businessId, email: maskEmail(user.email), emailDelivered: delivery.delivered });
  res.json({ success: true, message: 'A new activation link has been issued.', ...(process.env.NODE_ENV !== 'production' && delivery.developmentUrl ? { developmentActivationUrl: delivery.developmentUrl } : {}) });
}));

router.post('/forgot-password', asyncHandler(async (req, res) => {
  const { email } = z.object({ email: z.email() }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  const generic = { success: true, message: 'If an activated account exists for this email, a password reset link has been sent.' };
  if (!user) {
    logger.warn('Password reset skipped; account not found', { event: 'PASSWORD_RESET_SKIPPED', requestId: req.id, reason: 'ACCOUNT_NOT_FOUND', email: maskEmail(email), ip: req.ip });
    return res.json(generic);
  }
  if (!user.emailVerifiedAt) {
    logger.warn('Password reset skipped; account is not activated', { event: 'PASSWORD_RESET_SKIPPED', requestId: req.id, reason: 'ACCOUNT_NOT_ACTIVATED', userId: user.id, businessId: user.businessId, email: maskEmail(user.email), ip: req.ip });
    return res.json(generic);
  }
  const token = crypto.randomBytes(32).toString('base64url');
  await prisma.user.update({ where: { id: user.id }, data: {
    passwordResetTokenHash: hashToken(token),
    passwordResetExpiresAt: new Date(Date.now() + config.passwordResetMinutes * 60000),
  }});
  const resetUrl = buildFrontendUrl(req, '/reset-password', token);
  const delivery = await safeDeliver(sendPasswordResetEmail({ email: user.email, name: user.name, resetUrl }), resetUrl);
  logger.info('Password reset requested', { event: 'PASSWORD_RESET_REQUESTED', requestId: req.id, userId: user.id, businessId: user.businessId, email: maskEmail(user.email), emailDelivered: delivery.delivered });
  res.json({ ...generic, ...(process.env.NODE_ENV !== 'production' && delivery.developmentUrl ? { developmentResetUrl: delivery.developmentUrl } : {}) });
}));

router.get('/password-reset/:token', asyncHandler(async (req, res) => {
  const user = await prisma.user.findFirst({ where: { passwordResetTokenHash: hashToken(req.params.token) }, select: { email: true, passwordResetExpiresAt: true } });
  if (!user) return res.status(404).json({ success: false, message: 'Password reset link is invalid or has already been used.' });
  if (user.passwordResetExpiresAt < new Date()) return res.status(410).json({ success: false, message: 'Password reset link has expired. Request a new one.' });
  res.json({ success: true, email: maskEmail(user.email) });
}));

router.post('/reset-password', asyncHandler(async (req, res) => {
  const input = z.object({ token: z.string().min(20), password: z.string().min(6).max(100), confirmPassword: z.string().min(6).max(100) }).parse(req.body);
  if (input.password !== input.confirmPassword) return res.status(400).json({ success: false, message: 'New password and confirmation do not match.' });
  if (!isStrongPassword(input.password)) return res.status(400).json({ success: false, message: passwordMessage });
  const user = await prisma.user.findFirst({ where: { passwordResetTokenHash: hashToken(input.token) } });
  if (!user) return res.status(404).json({ success: false, message: 'Password reset link is invalid or has already been used.' });
  if (user.passwordResetExpiresAt < new Date()) return res.status(410).json({ success: false, message: 'Password reset link has expired. Request a new one.' });
  if (await bcrypt.compare(input.password, user.passwordHash)) return res.status(400).json({ success: false, message: 'Choose a password different from your current password.' });
  await prisma.user.update({ where: { id: user.id }, data: {
    passwordHash: await bcrypt.hash(input.password, 12), passwordResetTokenHash: null,
    passwordResetExpiresAt: null, tokenVersion: { increment: 1 },
  }});
  logger.warn('Password reset completed; sessions revoked', { event: 'PASSWORD_RESET_COMPLETED', requestId: req.id, userId: user.id, businessId: user.businessId, email: maskEmail(user.email) });
  res.json({ success: true, message: 'Password reset successfully. Sign in with your new password.' });
}));

router.post('/change-password', requireDashboardAuth, asyncHandler(async (req, res) => {
  const input = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(6).max(100), confirmPassword: z.string().min(6).max(100) }).parse(req.body);
  if (input.newPassword !== input.confirmPassword) return res.status(400).json({ success: false, message: 'New password and confirmation do not match.' });
  if (!isStrongPassword(input.newPassword)) return res.status(400).json({ success: false, message: passwordMessage });
  const user = await prisma.user.findUnique({ where: { id: req.auth.sub } });
  if (!user || !await bcrypt.compare(input.currentPassword, user.passwordHash)) return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
  if (await bcrypt.compare(input.newPassword, user.passwordHash)) return res.status(400).json({ success: false, message: 'New password must be different from the current password.' });
  await prisma.user.update({ where: { id: user.id }, data: {
    passwordHash: await bcrypt.hash(input.newPassword, 12), passwordResetTokenHash: null,
    passwordResetExpiresAt: null, tokenVersion: { increment: 1 },
  }});
  logger.warn('Password changed; sessions revoked', { event: 'PASSWORD_CHANGED', requestId: req.id, userId: user.id, businessId: user.businessId, email: maskEmail(user.email) });
  res.json({ success: true, message: 'Password changed. Sign in again on all devices.' });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const input = z.object({ email: z.email(), password: z.string().min(1) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() }, include: { business: true } });
  if (!user || !await bcrypt.compare(input.password, user.passwordHash)) {
    logger.warn('Login rejected', { event: 'LOGIN_FAILED', requestId: req.id, email: maskEmail(input.email), reason: 'invalid_credentials', ip: req.ip });
    return res.status(401).json({ success: false, message: 'Invalid email or password' });
  }
  if (!user.emailVerifiedAt) {
    logger.warn('Login rejected for unactivated account', { event: 'LOGIN_BLOCKED', requestId: req.id, userId: user.id, businessId: user.businessId, email: maskEmail(user.email), ip: req.ip });
    return res.status(403).json({ success: false, code: 'ACCOUNT_NOT_ACTIVATED', message: 'Your account has not been activated. Check your email for the activation link.' });
  }
  const otp = String(crypto.randomInt(100000, 1000000));
  const challenge = crypto.randomBytes(24).toString('base64url');
  await prisma.user.update({ where: { id: user.id }, data: {
    loginOtpChallengeHash: hashToken(challenge), loginOtpHash: hashToken(otp),
    loginOtpExpiresAt: new Date(Date.now() + config.loginOtpMinutes * 60000), loginOtpAttempts: 0,
  }});
  let delivery;
  try { delivery = await sendLoginOtpEmail({ email: user.email, name: user.name, otp }); }
  catch (error) {
    await prisma.user.update({ where: { id: user.id }, data: { loginOtpChallengeHash: null, loginOtpHash: null, loginOtpExpiresAt: null, loginOtpAttempts: 0 } });
    logger.error('Login OTP email delivery failed; login blocked', { event: 'LOGIN_OTP_DELIVERY_FAILED', requestId: req.id, userId: user.id, businessId: user.businessId, email: maskEmail(user.email), ...safeError(error) });
    return res.status(503).json({ success: false, code: 'OTP_DELIVERY_FAILED', message: 'We could not send your login code right now. Please try again in a moment.' });
  }
  logger.info('Login credentials accepted; OTP challenge issued', { event: 'LOGIN_OTP_ISSUED', requestId: req.id, userId: user.id, businessId: user.businessId, email: maskEmail(user.email), emailDelivered: delivery.delivered, ip: req.ip });
  res.json({ success: true, requiresOtp: true, challenge, maskedEmail: maskEmail(user.email), expiresIn: config.loginOtpMinutes * 60, ...(process.env.NODE_ENV !== 'production' && delivery.developmentOtp ? { developmentOtp: delivery.developmentOtp } : {}) });
}));

router.post('/verify-login-otp', asyncHandler(async (req, res) => {
  const input = z.object({ challenge: z.string().min(20), otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit login code.') }).parse(req.body);
  const user = await prisma.user.findFirst({ where: { loginOtpChallengeHash: hashToken(input.challenge) }, include: { business: true } });
  if (!user || !user.loginOtpExpiresAt) return res.status(401).json({ success: false, message: 'Login verification session is invalid. Sign in again.' });
  if (user.loginOtpExpiresAt < new Date()) return res.status(410).json({ success: false, message: 'Login code expired. Sign in again to request a new code.' });
  if (user.loginOtpAttempts >= 5) return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Sign in again to request a new code.' });
  if (user.loginOtpHash !== hashToken(input.otp)) {
    await prisma.user.update({ where: { id: user.id }, data: { loginOtpAttempts: { increment: 1 } } });
    logger.warn('Login OTP rejected', { event: 'LOGIN_OTP_FAILED', requestId: req.id, userId: user.id, businessId: user.businessId, attempt: user.loginOtpAttempts + 1, ip: req.ip });
    return res.status(401).json({ success: false, message: 'Incorrect login code.' });
  }
  const verified = await prisma.user.update({ where: { id: user.id }, data: {
    loginOtpChallengeHash: null, loginOtpHash: null, loginOtpExpiresAt: null, loginOtpAttempts: 0,
  }, include: { business: true } });
  logger.info('User login completed with email OTP', { event: 'LOGIN_SUCCESS', requestId: req.id, userId: user.id, businessId: user.businessId, email: maskEmail(user.email), ip: req.ip });
  res.json({ success: true, token: authToken(verified), user: sanitize(verified) });
}));

router.get('/me', requireDashboardAuth, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth.sub }, include: { business: true } });
  res.json({ success: true, user: sanitize(user) });
}));

function sanitize(user) {
  return { id: user.id, name: user.name, email: user.email, mobile: user.mobile, role: user.role, emailVerifiedAt: user.emailVerifiedAt, business: user.business };
}

const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const maskEmail = email => email.replace(/^(.{2}).*(@.*)$/, '$1•••$2');

module.exports = router;
