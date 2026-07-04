const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const prisma = require('../db');
const config = require('../config');
const asyncHandler = require('../lib/asyncHandler');
const { logger } = require('../lib/logger');

const router = express.Router();

router.post('/token', asyncHandler(async (req, res) => {
  const input = z.object({
    grant_type: z.literal('client_credentials'), app_id: z.string().min(10), app_secret: z.string().min(20),
  }).parse(req.body);
  const client = await prisma.apiClient.findUnique({ where: { appId: input.app_id } });
  if (!client?.active || !await bcrypt.compare(input.app_secret, client.secretHash)) {
    logger.warn('OAuth token request rejected', { event: 'OAUTH_TOKEN_REJECTED', requestId: req.id, appId: input.app_id, ip: req.ip });
    return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid App ID or App Secret' });
  }
  const accessToken = jwt.sign({ sub: client.id, appId: client.appId, businessId: client.businessId, kind: 'client', ver: client.tokenVersion }, config.jwtSecret, { expiresIn: config.accessTokenTtl });
  await prisma.apiClient.update({ where: { id: client.id }, data: { lastUsedAt: new Date() } });
  logger.info('OAuth access token issued', { event: 'OAUTH_TOKEN_ISSUED', requestId: req.id, businessId: client.businessId, clientId: client.id, appId: client.appId, ip: req.ip });
  res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 900 });
}));

module.exports = router;
