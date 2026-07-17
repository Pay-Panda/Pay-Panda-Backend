const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const prisma = require('../../db');
const config = require('../../config');
const asyncHandler = require('../../lib/asyncHandler');
const { requireAdminAuth } = require('../../middleware/auth');
const { isStrongPassword, passwordMessage } = require('../../lib/password');
const { logger } = require('../../lib/logger');

const router = express.Router();
const adminToken = admin => jwt.sign({ sub: admin.id, kind: 'admin', ver: admin.tokenVersion }, config.jwtSecret, { expiresIn: config.adminAccessTokenTtl });
const envAdminToken = () => jwt.sign({
  sub: config.superAdmin.id,
  kind: 'admin',
  envAdmin: true,
  ver: config.superAdmin.credentialVersion,
}, config.jwtSecret, { expiresIn: config.adminAccessTokenTtl });
const maskEmail = email => email.replace(/^(.{2}).*(@.*)$/, '$1•••$2');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => `${ipKeyGenerator(req.ip)}:${String(req.body?.email || '').toLowerCase()}`,
  handler: (req, res) => res.status(429).json({ success: false, message: 'Too many login attempts. Try again later.' }),
});

router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const input = z.object({ email: z.email(), password: z.string().min(1) }).parse(req.body);
  if (isEnvSuperAdmin(input.email, input.password)) {
    const admin = envAdminProfile();
    logger.info('Env super-admin login succeeded', { event: 'ENV_ADMIN_LOGIN_SUCCESS', requestId: req.id, adminId: admin.id, email: maskEmail(admin.email), ip: req.ip });
    return res.json({ success: true, token: envAdminToken(), admin });
  }
  const admin = await prisma.adminUser.findFirst({ where: { email: { equals: input.email, mode: 'insensitive' } } });
  if (!admin || !admin.active || !await bcrypt.compare(input.password, admin.passwordHash)) {
    logger.warn('Admin login rejected', { event: 'ADMIN_LOGIN_FAILED', requestId: req.id, email: maskEmail(input.email), ip: req.ip });
    return res.status(401).json({ success: false, message: 'Invalid email or password' });
  }
  await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
  logger.info('Admin login succeeded', { event: 'ADMIN_LOGIN_SUCCESS', requestId: req.id, adminId: admin.id, email: maskEmail(admin.email), ip: req.ip });
  res.json({ success: true, token: adminToken(admin), admin: sanitize(admin) });
}));

router.get('/me', requireAdminAuth, asyncHandler(async (req, res) => {
  if (req.auth.envAdmin) return res.json({ success: true, admin: envAdminProfile() });
  const admin = await prisma.adminUser.findUnique({ where: { id: req.auth.sub } });
  res.json({ success: true, admin: sanitize(admin) });
}));

router.post('/change-password', requireAdminAuth, asyncHandler(async (req, res) => {
  if (req.auth.envAdmin) {
    return res.status(400).json({
      success: false,
      message: 'This super-admin password is managed from backend environment variables. Update SUPER_ADMIN_PASSWORD and restart the backend.',
    });
  }
  const input = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(6).max(100), confirmPassword: z.string().min(6).max(100) }).parse(req.body);
  if (input.newPassword !== input.confirmPassword) return res.status(400).json({ success: false, message: 'New password and confirmation do not match.' });
  if (!isStrongPassword(input.newPassword)) return res.status(400).json({ success: false, message: passwordMessage });
  const admin = await prisma.adminUser.findUnique({ where: { id: req.auth.sub } });
  if (!admin || !await bcrypt.compare(input.currentPassword, admin.passwordHash)) return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
  if (await bcrypt.compare(input.newPassword, admin.passwordHash)) return res.status(400).json({ success: false, message: 'New password must be different from the current password.' });
  await prisma.adminUser.update({ where: { id: admin.id }, data: {
    passwordHash: await bcrypt.hash(input.newPassword, 12), tokenVersion: { increment: 1 },
  }});
  logger.warn('Admin password changed; sessions revoked', { event: 'ADMIN_PASSWORD_CHANGED', requestId: req.id, adminId: admin.id, email: maskEmail(admin.email) });
  res.json({ success: true, message: 'Password changed. Sign in again on all devices.' });
}));

function sanitize(admin) {
  return { id: admin.id, name: admin.name, email: admin.email, active: admin.active, lastLoginAt: admin.lastLoginAt };
}

function isEnvSuperAdmin(email, password) {
  return Boolean(config.superAdmin.email && config.superAdmin.password
    && email.toLowerCase() === config.superAdmin.email
    && password === config.superAdmin.password);
}

function envAdminProfile() {
  return {
    id: config.superAdmin.id,
    name: config.superAdmin.name,
    email: config.superAdmin.email,
    active: true,
    envManaged: true,
    lastLoginAt: null,
  };
}

module.exports = router;
