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
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { tokenVersion: true, emailVerifiedAt: true, business: { select: { suspendedAt: true } } },
    });
    if (!user?.emailVerifiedAt || user.tokenVersion !== payload.ver) throw new Error('User session was revoked');
    if (user.business?.suspendedAt) {
      return res.status(403).json({ success: false, code: 'BUSINESS_SUSPENDED', message: 'This account has been suspended. Contact support.' });
    }
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
    const client = await prisma.apiClient.findUnique({
      where: { id: payload.sub },
      select: { active: true, tokenVersion: true, business: { select: { suspendedAt: true } } },
    });
    if (!client?.active || client.tokenVersion !== payload.ver) throw new Error('OAuth client was revoked or rotated');
    if (client.business?.suspendedAt) {
      return res.status(403).json({ success: false, code: 'BUSINESS_SUSPENDED', message: 'This account has been suspended. Contact support.' });
    }
    req.auth = payload;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Valid OAuth access token required' });
  }
}

async function requireAdminAuth(req, res, next) {
  try {
    const payload = jwt.verify(readBearer(req), jwtSecret);
    if (payload.kind !== 'admin') throw new Error('Wrong token type');
    const admin = await prisma.adminUser.findUnique({ where: { id: payload.sub }, select: { active: true, tokenVersion: true } });
    if (!admin?.active || admin.tokenVersion !== payload.ver) throw new Error('Admin session was revoked');
    req.auth = payload;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Valid admin access token required' });
  }
}

module.exports = { readBearer, requireDashboardAuth, requireApiAuth, requireAdminAuth };
