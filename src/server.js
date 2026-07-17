const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const { ZodError } = require('zod');
const config = require('./config');
const prisma = require('./db');
const { expirePendingPayments, reconcileRecentPayments } = require('./services/poller');
const { logger, safeError, logDir } = require('./lib/logger');

const app = express();
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
// FRONTEND_URL supports a single origin, a comma-separated list (multiple deployed
// frontends), or "*" to allow every origin. Browsers reject comma-separated
// Access-Control-Allow-Origin values, so always echo exactly one allowed origin.
const allowedOrigins = parseCorsOrigins(config.frontendUrl);
const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins === '*' || allowedOrigins.has(origin)) return callback(null, origin);
    return callback(Object.assign(new Error(`CORS blocked origin: ${origin}`), { statusCode: 403 }));
  },
  credentials: allowedOrigins !== '*',
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => { req.id = crypto.randomUUID(); res.set('X-Request-Id', req.id); next(); });
app.use((req, res, next) => {
  const started = Date.now();
  logger.debug('Request received', { event: 'HTTP_IN', requestId: req.id, method: req.method, path: sanitizeLogPath(req.originalUrl), ip: req.ip });
  res.on('finish', () => {
    const durationMs = Date.now() - started;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'http';
    logger.log(level, 'Request completed', { event: 'HTTP_OUT', requestId: req.id, method: req.method, path: sanitizeLogPath(req.originalUrl), statusCode: res.statusCode, durationMs, businessId: req.auth?.businessId, appId: req.auth?.appId });
    if (!shouldPersistRequestAudit(req)) return;
    prisma.apiRequestLog.create({ data: {
      businessId: req.auth?.businessId || null, appId: req.auth?.appId || null,
      method: req.method, path: sanitizeLogPath(req.originalUrl).slice(0, 500), statusCode: res.statusCode,
      requestId: req.id, ipAddress: req.ip, durationMs,
    }}).catch(error => logger.error('Failed to persist request audit log', { event: 'AUDIT_LOG_ERROR', requestId: req.id, ...safeError(error) }));
  });
  next();
});

app.get('/api/health', (req, res) => res.json({ success: true, service: 'pay-panda-api', time: new Date().toISOString() }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/oauth', require('./routes/oauth'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/connections', require('./routes/connections'));
app.use('/api', require('./routes/payments'));
app.use('/api/public', require('./routes/public'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/admin/auth', require('./routes/admin/auth'));
app.use('/api/admin', require('./routes/admin/index'));

app.use((req, res) => res.status(404).json({ success: false, message: 'Route not found' }));
app.use((error, req, res, next) => {
  if (error instanceof ZodError) {
    const fieldErrors = {};
    for (const issue of error.issues) {
      const field = issue.path.join('.') || 'request';
      if (!fieldErrors[field]) fieldErrors[field] = friendlyValidationMessage(field, issue);
    }
    const firstMessage = Object.values(fieldErrors)[0] || 'Please check the submitted values.';
    return res.status(400).json({ success: false, message: firstMessage, fieldErrors, errors: error.issues });
  }
  logger.error('Unhandled request error', { event: 'REQUEST_ERROR', requestId: req.id, method: req.method, path: sanitizeLogPath(req.originalUrl), ...safeError(error) });
  res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : 'Internal server error' });
});

const server = app.listen(config.port, () => logger.info(`Pay-Panda API running at http://localhost:${config.port}`, { event: 'SERVER_READY', port: config.port, environment: process.env.NODE_ENV, logDirectory: logDir }));
const expiryTimer = setInterval(() => expirePendingPayments().catch(error => logger.error('Local payment expiry job failed', { event: 'EXPIRY_JOB_ERROR', ...safeError(error) })), 30000);
const reconciliationTimer = setInterval(() => reconcileRecentPayments().catch(error => logger.error('Scheduled reconciliation failed', { event: 'RECONCILIATION_ERROR', ...safeError(error) })), config.reconciliationIntervalMs);
expiryTimer.unref();
reconciliationTimer.unref();

async function shutdown() {
  logger.warn('Graceful shutdown requested', { event: 'SERVER_SHUTDOWN' });
  clearInterval(expiryTimer);
  clearInterval(reconciliationTimer);
  server.close(async () => { await prisma.$disconnect(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = app;

function parseCorsOrigins(value) {
  const origins = new Set();
  for (const item of String(value || '').split(',')) {
    const origin = item.trim().replace(/\/+$/, '');
    if (origin === '*') return '*';
    if (origin) origins.add(origin);
  }
  return origins;
}

function sanitizeLogPath(value) {
  return value.replace(/(\/api\/auth\/activation\/)[^?]+/i, '$1[redacted]').replace(/([?&](?:token|app_secret)=)[^&]+/gi, '$1[redacted]');
}

function shouldPersistRequestAudit(req) {
  if (req.method === 'OPTIONS') return false;
  if (req.method === 'GET' && (req.path === '/api/health' || req.path.startsWith('/api/admin') || req.path.startsWith('/api/public'))) return false;
  return true;
}

function friendlyValidationMessage(field, issue) {
  const labels = { mobile: 'Mobile number', customer_mobile: 'Customer mobile', email: 'Email address', password: 'Password', confirmPassword: 'Password confirmation', amount: 'Amount', redirect_url: 'Redirect URL', order_id: 'Order ID' };
  const label = labels[field] || field.replaceAll('_', ' ');
  if (issue.message && !issue.message.startsWith('Invalid string')) return issue.message;
  if (issue.code === 'invalid_type') return `${label} is required and must have the correct format.`;
  if (issue.code === 'too_small') return `${label} is too short.`;
  if (issue.code === 'too_big') return `${label} is too long.`;
  return `${label} has an invalid format.`;
}
