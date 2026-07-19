const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const prisma = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { randomId } = require('../lib/crypto');
const { requireDashboardAuth } = require('../middleware/auth');
const { sendSecurityAlertEmail } = require('../services/emailService');
const { logger, safeError } = require('../lib/logger');

const router = express.Router();
router.use(requireDashboardAuth);

// Security-sensitive account actions are best-effort side effects — never let email
// delivery block or fail the actual credential operation.
function notifySecurityAlert(businessId, action, detail) {
  prisma.business.findUnique({ where: { id: businessId }, select: { name: true, supportEmail: true } })
    .then(business => {
      if (!business?.supportEmail) return;
      return sendSecurityAlertEmail({ email: business.supportEmail, businessName: business.name, action, detail });
    })
    .catch(error => logger.error('Security alert email failed', { event: 'SECURITY_ALERT_EMAIL_FAILED', businessId, action, ...safeError(error) }));
}

router.get('/', asyncHandler(async (req, res) => {
  const clients = await prisma.apiClient.findMany({ where: { businessId: req.auth.businessId }, select: {
    id: true, name: true, appId: true, active: true, lastUsedAt: true, createdAt: true,
    businessUnit: { select: { id: true, name: true, code: true } },
  }});
  res.json({ success: true, clients });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, businessUnitId } = z.object({ name: z.string().min(2).max(80), businessUnitId: z.string().min(1).optional() }).parse(req.body);
  const activeCount = await prisma.apiClient.count({ where: { businessId: req.auth.businessId, active: true } });
  if (activeCount >= 5) return res.status(409).json({ success: false, code: 'CLIENT_LIMIT_REACHED', message: 'A workspace can have a maximum of 5 active app credentials. Revoke an unused credential first.' });
  let businessUnit = null;
  if (businessUnitId) {
    businessUnit = await prisma.businessUnit.findFirst({ where: { id: businessUnitId, businessId: req.auth.businessId, active: true } });
    if (!businessUnit) return res.status(404).json({ success: false, message: 'Selected sub-business is not active or does not exist' });
  }
  const appId = randomId('app', 15);
  const appSecret = randomId('secret', 30);
  const client = await prisma.apiClient.create({ data: {
    businessId: req.auth.businessId, businessUnitId: businessUnit?.id, name, appId, secretHash: await bcrypt.hash(appSecret, 12),
  }});
  logger.info('OAuth application created', { event: 'OAUTH_CLIENT_CREATED', requestId: req.id, businessId: req.auth.businessId, businessUnitId: businessUnit?.id, clientId: client.id, appId: client.appId, name: client.name });
  notifySecurityAlert(req.auth.businessId, 'New app credential created', `A new app credential named "${name}" (App ID ${appId}) was created${businessUnit ? ` for sub-business "${businessUnit.name}"` : ''}. It can create and manage payments on your account.`);
  res.status(201).json({
    success: true,
    client: { id: client.id, name, appId, appSecret, createdAt: client.createdAt, businessUnit: businessUnit ? { id: businessUnit.id, name: businessUnit.name, code: businessUnit.code } : null },
    message: 'Copy the App Secret now. It will not be shown again.',
  });
}));

router.post('/:id/rotate', asyncHandler(async (req, res) => {
  const client = await prisma.apiClient.findFirst({ where: { id: req.params.id, businessId: req.auth.businessId } });
  if (!client) return res.status(404).json({ success: false, message: 'OAuth application not found' });
  const appSecret = randomId('secret', 30);
  await prisma.apiClient.update({ where: { id: client.id }, data: { secretHash: await bcrypt.hash(appSecret, 12), active: true, tokenVersion: { increment: 1 } } });
  logger.warn('OAuth client secret rotated', { event: 'OAUTH_CLIENT_ROTATED', requestId: req.id, businessId: req.auth.businessId, clientId: client.id, appId: client.appId });
  notifySecurityAlert(req.auth.businessId, 'App Secret rotated', `The App Secret for "${client.name}" (App ID ${client.appId}) was rotated. The previous secret no longer works.`);
  res.json({ success: true, client: { id: client.id, appId: client.appId, appSecret }, message: 'The previous App Secret has been revoked.' });
}));

router.post('/:id/revoke', asyncHandler(async (req, res) => {
  const client = await prisma.apiClient.findFirst({ where: { id: req.params.id, businessId: req.auth.businessId } });
  if (!client) return res.status(404).json({ success: false, message: 'OAuth application not found' });
  await prisma.apiClient.update({ where: { id: client.id }, data: { active: false, tokenVersion: { increment: 1 } } });
  logger.warn('OAuth application revoked', { event: 'OAUTH_CLIENT_REVOKED', requestId: req.id, businessId: req.auth.businessId, clientId: req.params.id });
  notifySecurityAlert(req.auth.businessId, 'App credential revoked', `The app credential "${client.name}" (App ID ${client.appId}) was revoked and can no longer access your account.`);
  res.json({ success: true });
}));

module.exports = router;
