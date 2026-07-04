const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const prisma = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { randomId } = require('../lib/crypto');
const { requireDashboardAuth } = require('../middleware/auth');
const { logger } = require('../lib/logger');

const router = express.Router();
router.use(requireDashboardAuth);

router.get('/', asyncHandler(async (req, res) => {
  const clients = await prisma.apiClient.findMany({ where: { businessId: req.auth.businessId }, select: {
    id: true, name: true, appId: true, active: true, lastUsedAt: true, createdAt: true,
  }});
  res.json({ success: true, clients });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name } = z.object({ name: z.string().min(2).max(80) }).parse(req.body);
  const activeCount = await prisma.apiClient.count({ where: { businessId: req.auth.businessId, active: true } });
  if (activeCount >= 5) return res.status(409).json({ success: false, code: 'CLIENT_LIMIT_REACHED', message: 'A workspace can have a maximum of 5 active app credentials. Revoke an unused credential first.' });
  const appId = randomId('app', 15);
  const appSecret = randomId('secret', 30);
  const client = await prisma.apiClient.create({ data: {
    businessId: req.auth.businessId, name, appId, secretHash: await bcrypt.hash(appSecret, 12),
  }});
  logger.info('OAuth application created', { event: 'OAUTH_CLIENT_CREATED', requestId: req.id, businessId: req.auth.businessId, clientId: client.id, appId: client.appId, name: client.name });
  res.status(201).json({ success: true, client: { id: client.id, name, appId, appSecret, createdAt: client.createdAt }, message: 'Copy the App Secret now. It will not be shown again.' });
}));

router.post('/:id/rotate', asyncHandler(async (req, res) => {
  const client = await prisma.apiClient.findFirst({ where: { id: req.params.id, businessId: req.auth.businessId } });
  if (!client) return res.status(404).json({ success: false, message: 'OAuth application not found' });
  const appSecret = randomId('secret', 30);
  await prisma.apiClient.update({ where: { id: client.id }, data: { secretHash: await bcrypt.hash(appSecret, 12), active: true, tokenVersion: { increment: 1 } } });
  logger.warn('OAuth client secret rotated', { event: 'OAUTH_CLIENT_ROTATED', requestId: req.id, businessId: req.auth.businessId, clientId: client.id, appId: client.appId });
  res.json({ success: true, client: { id: client.id, appId: client.appId, appSecret }, message: 'The previous App Secret has been revoked.' });
}));

router.post('/:id/revoke', asyncHandler(async (req, res) => {
  const result = await prisma.apiClient.updateMany({ where: { id: req.params.id, businessId: req.auth.businessId }, data: { active: false, tokenVersion: { increment: 1 } } });
  if (!result.count) return res.status(404).json({ success: false, message: 'OAuth application not found' });
  logger.warn('OAuth application revoked', { event: 'OAUTH_CLIENT_REVOKED', requestId: req.id, businessId: req.auth.businessId, clientId: req.params.id });
  res.json({ success: true });
}));

module.exports = router;
