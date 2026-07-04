const QRCode = require('qrcode');
const prisma = require('../db');
const { publicAppUrl, paymentExpiryMinutes } = require('../config');
const { randomId } = require('../lib/crypto');
const bharatpe = require('../providers/bharatpe');
const { logger } = require('../lib/logger');

async function createPayment(businessId, input, source = 'API') {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw Object.assign(new Error('Business not found'), { statusCode: 404 });

  const connection = input.connectionId
    ? await prisma.merchantConnection.findFirst({ where: { id: input.connectionId, businessId, status: 'ACTIVE' } })
    : await prisma.merchantConnection.findFirst({ where: { businessId, status: 'ACTIVE' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
  if (!connection?.baseUpiIntent) throw Object.assign(new Error('Connect an active BharatPe account first'), { statusCode: 409 });

  const existing = await prisma.payment.findUnique({
    where: { businessId_clientOrderId: { businessId, clientOrderId: input.orderId } },
  });
  if (existing) return { payment: existing, created: false };

  const upiIntent = bharatpe.createPaymentIntent(connection.baseUpiIntent, {
    amount: input.amount,
    customerName: input.customerName,
    reason: input.reason,
    clientOrderId: input.orderId,
  });
  const qrImage = await QRCode.toBuffer(upiIntent, { type: 'png', width: 480, margin: 2, errorCorrectionLevel: 'M' });
  const expiryMins = input.expiresInMinutes || business.paymentExpiryMins || paymentExpiryMinutes;
  const payment = await prisma.payment.create({ data: {
    publicId: randomId('pay'), businessId, connectionId: connection.id,
    clientOrderId: input.orderId, customerName: input.customerName,
    customerMobile: input.customerMobile, amount: input.amount,
    reason: input.reason, remark1: input.remark1, remark2: input.remark2,
    redirectUrl: input.redirectUrl, source, upiIntent, qrImage,
    expiresAt: new Date(Date.now() + expiryMins * 60000),
  }});
  logger.info('Payment session created', { event: 'PAYMENT_CREATED', businessId, paymentId: payment.publicId, orderId: payment.clientOrderId, amount: Number(payment.amount), source, connectionId: connection.id, expiresAt: payment.expiresAt });
  return { payment, created: true };
}

function publicPayment(payment) {
  return {
    id: payment.publicId,
    orderId: payment.clientOrderId,
    amount: Number(payment.amount),
    currency: payment.currency,
    customerName: payment.customerName,
    customerMobile: payment.customerMobile,
    reason: payment.reason,
    remark1: payment.remark1,
    remark2: payment.remark2,
    status: payment.status,
    bankReferenceNo: payment.bankReferenceNo,
    payerName: payment.payerName,
    payerHandle: payment.payerHandle,
    paidAt: payment.paidAt,
    redirectUrl: payment.redirectUrl,
    upiIntent: payment.upiIntent,
    expiresAt: payment.expiresAt,
    createdAt: payment.createdAt,
    checkoutUrl: `${publicAppUrl}/pay/${payment.publicId}`,
    qrPath: `/api/public/payments/${payment.publicId}/qr`,
    provider: payment.connection?.provider,
    payee: payment.connection ? {
      name: payment.connection.legalBusinessName || payment.connection.merchantName,
      mobile: payment.connection.mobile,
      upiId: payment.connection.upiId,
    } : undefined,
  };
}

module.exports = { createPayment, publicPayment };
