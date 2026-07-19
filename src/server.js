const config = require('./config');
const prisma = require('./db');
const app = require('./app');
const { expirePendingPayments, reconcileRecentPayments } = require('./services/poller');
const { retryPendingWebhooks } = require('./services/webhookService');
const { logger, safeError, logDir } = require('./lib/logger');

const server = app.listen(config.port, () => logger.info(`Pay-Panda API running at http://localhost:${config.port}`, { event: 'SERVER_READY', port: config.port, environment: process.env.NODE_ENV, logDirectory: logDir }));
const expiryTimer = setInterval(() => expirePendingPayments().catch(error => logger.error('Local payment expiry job failed', { event: 'EXPIRY_JOB_ERROR', ...safeError(error) })), 30000);
const reconciliationTimer = setInterval(() => reconcileRecentPayments().catch(error => logger.error('Scheduled reconciliation failed', { event: 'RECONCILIATION_ERROR', ...safeError(error) })), config.reconciliationIntervalMs);
const webhookRetryTimer = setInterval(() => retryPendingWebhooks().catch(error => logger.error('Webhook retry job failed', { event: 'WEBHOOK_RETRY_JOB_ERROR', ...safeError(error) })), 60000);
expiryTimer.unref();
reconciliationTimer.unref();
webhookRetryTimer.unref();

async function shutdown() {
  logger.warn('Graceful shutdown requested', { event: 'SERVER_SHUTDOWN' });
  clearInterval(expiryTimer);
  clearInterval(reconciliationTimer);
  clearInterval(webhookRetryTimer);
  server.close(async () => { await prisma.$disconnect(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = app;
