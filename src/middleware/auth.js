const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config');
const prisma = require('../db');

function readBearer(req) {
  const [scheme, token] = String(req.headers.authorization || '').split(' ');
  return scheme === 'Bearer' ? token : null;
}

async function requireDashboardAuth(req, res, next) {
  try {
    const payload = jwt.verify(readBearer(req), jwtSecret);
    if (payload.kind !== 'user') throw new Error('Wrong token type');
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { tokenVersion: true, emailVerifiedAt: true } });
    if (!user?.emailVerifiedAt || user.tokenVersion !== payload.ver) throw new Error('User session was revoked');
    req.auth = payload;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Valid user access token required' });
  }
}

async function requireApiAuth(req, res, next) {
  try {
    const payload = jwt.verify(readBearer(req), jwtSecret);
    if (payload.kind !== 'client') throw new Error('Wrong token type');
    const client = await prisma.apiClient.findUnique({ where: { id: payload.sub }, select: { active: true, tokenVersion: true } });
    if (!client?.active || client.tokenVersion !== payload.ver) throw new Error('OAuth client was revoked or rotated');
    req.auth = payload;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Valid OAuth access token required' });
  }
}

module.exports = { readBearer, requireDashboardAuth, requireApiAuth };
