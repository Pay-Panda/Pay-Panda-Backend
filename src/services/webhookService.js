const crypto = require('crypto');
const axios = require('axios');
const prisma = require('../db');
const { logger, safeError } = require('../lib/logger');

const MAX_ATTEMPTS = 6;
const BACKOFF_MINUTES = [1, 5, 15, 60, 180, 720];
const DELIVERY_TIMEOUT_MS = 8000;

function generateWebhookSecret() {
  return `whsec_${crypto.randomBytes(24).toString('base64url')}`;
}

function serializePaymentForWebhook(payment) {
  return {
    order_id: payment.clientOrderId,
    payment_id: payment.publicId,
    status: payment.status,
    amount: Number(payment.amount),
    currency: payment.currency,
    customer_name: payment.customerName,
    customer_mobile: payment.customerMobile,
    customer_email: payment.customerEmail,
    payer_name: payment.payerName,
    payer_handle: payment.payerHandle,
    bank_reference_no: payment.bankReferenceNo,
    business_unit_id: payment.businessUnitId,
    paid_at: payment.paidAt,
    created_at: payment.createdAt,
  };
}

function signPayload(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

async function attemptDelivery(delivery, secret) {
  const rawBody = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload(secret, timestamp, rawBody);

  try {
    const response = await axios.post(delivery.url, delivery.payload, {
      timeout: DELIVERY_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'X-Pay-Panda-Event': delivery.event,
        'X-Pay-Panda-Signature': `t=${timestamp},v1=${signature}`,
      },
      validateStatus: () => true,
    });
    const success = response.status >= 200 && response.status < 300;
    const attempts = delivery.attempts + 1;
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: success ? 'SUCCESS' : (attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING'),
        attempts,
        lastAttemptAt: new Date(),
        nextAttemptAt: success || attempts >= MAX_ATTEMPTS ? null : new Date(Date.now() + BACKOFF_MINUTES[attempts - 1] * 60000),
        responseStatus: response.status,
        responseBody: String(response.data ?? '').slice(0, 2000),
      },
    });
    if (!success) logger.warn('Webhook delivery failed', { event: 'WEBHOOK_DELIVERY_FAILED', deliveryId: delivery.id, businessId: delivery.businessId, status: response.status, attempts });
  } catch (error) {
    const attempts = delivery.attempts + 1;
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
        attempts,
        lastAttemptAt: new Date(),
        nextAttemptAt: attempts >= MAX_ATTEMPTS ? null : new Date(Date.now() + BACKOFF_MINUTES[attempts - 1] * 60000),
        responseBody: String(error.message || error).slice(0, 2000),
      },
    });
    logger.warn('Webhook delivery error', { event: 'WEBHOOK_DELIVERY_ERROR', deliveryId: delivery.id, businessId: delivery.businessId, attempts, ...safeError(error) });
  }
}

// Best-effort side effect — a merchant's webhook endpoint being slow or down must never
// block or roll back the payment status change that triggered it.
function queueWebhook(business, payment, event) {
  if (!business.webhookUrl || !business.webhookSecret) return;
  const payload = { event, data: serializePaymentForWebhook(payment) };

  prisma.webhookDelivery.create({
    data: { businessId: business.id, paymentId: payment.id, event, url: business.webhookUrl, payload },
  }).then(delivery => attemptDelivery(delivery, business.webhookSecret))
    .catch(error => logger.error('Webhook delivery record could not be created', { event: 'WEBHOOK_QUEUE_ERROR', businessId: business.id, paymentId: payment.id, ...safeError(error) }));
}

async function sendTestWebhook(business) {
  if (!business.webhookUrl || !business.webhookSecret) {
    throw Object.assign(new Error('Webhook URL and secret must be configured first'), { statusCode: 400 });
  }
  const payload = {
    event: 'webhook.test', data: { message: 'This is a test webhook from Pay-Panda', sentAt: new Date().toISOString() },
  };
  const timestamp = Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify(payload);
  const signature = signPayload(business.webhookSecret, timestamp, rawBody);
  const response = await axios.post(business.webhookUrl, payload, {
    timeout: DELIVERY_TIMEOUT_MS,
    headers: { 'Content-Type': 'application/json', 'X-Pay-Panda-Event': 'webhook.test', 'X-Pay-Panda-Signature': `t=${timestamp},v1=${signature}` },
    validateStatus: () => true,
  });
  return { status: response.status, ok: response.status >= 200 && response.status < 300 };
}

async function retryPendingWebhooks() {
  const due = await prisma.webhookDelivery.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
    include: { business: true },
    take: 50,
  });
  for (const delivery of due) {
    if (!delivery.business.webhookUrl || !delivery.business.webhookSecret) continue;
    await attemptDelivery(delivery, delivery.business.webhookSecret);
  }
  return due.length;
}

module.exports = { generateWebhookSecret, queueWebhook, sendTestWebhook, retryPendingWebhooks };
