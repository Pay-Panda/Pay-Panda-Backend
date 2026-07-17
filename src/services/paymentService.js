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
  const businessUnit = input.businessUnitId
    ? await prisma.businessUnit.findFirst({ where: { id: input.businessUnitId, businessId, active: true } })
    : input.businessUnitCode
      ? await prisma.businessUnit.findFirst({ where: { businessId, code: input.businessUnitCode, active: true } })
      : null;
  if ((input.businessUnitId || input.businessUnitCode) && !businessUnit) throw Object.assign(new Error('Selected sub-business is not active or does not exist'), { statusCode: 404 });

  const existing = await prisma.payment.findUnique({
    where: { businessId_clientOrderId: { businessId, clientOrderId: input.orderId } },
    include: { businessUnit: true, connection: true },
  });
  if (existing) return { payment: existing, created: false };

  const upiIntent = bharatpe.createPaymentIntent(connection.baseUpiIntent, {
    amount: input.amount,
    reason: input.reason,
    remark1: input.remark1,
    remark2: input.remark2,
    clientOrderId: input.orderId,
  });
  const qrImage = await QRCode.toBuffer(upiIntent, { type: 'png', width: 480, margin: 2, errorCorrectionLevel: 'M' });
  const expiryMins = input.expiresInMinutes || business.paymentExpiryMins || paymentExpiryMinutes;
  const payment = await prisma.payment.create({
    data: {
      publicId: randomId('pay'), businessId, businessUnitId: businessUnit?.id, connectionId: connection.id,
      clientOrderId: input.orderId, customerName: input.customerName,
      customerMobile: input.customerMobile, amount: input.amount,
      reason: input.reason, remark1: input.remark1, remark2: input.remark2,
      redirectUrl: input.redirectUrl, source, upiIntent, qrImage,
      expiresAt: new Date(Date.now() + expiryMins * 60000),
    },
    include: { businessUnit: true, connection: true },
  });
  logger.info('Payment session created', { event: 'PAYMENT_CREATED', businessId, businessUnitId: businessUnit?.id, paymentId: payment.publicId, orderId: payment.clientOrderId, amount: Number(payment.amount), source, connectionId: connection.id, expiresAt: payment.expiresAt });
  return { payment, created: true };
}

function publicPayment(payment) {
  const checkoutUrl = `${publicAppUrl}/pay/${payment.publicId}`;
  const qrPath = `/api/public/payments/${payment.publicId}/qr`;
  const payload = {
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
    checkoutUrl,
    qrPath,
    provider: payment.connection?.provider,
    businessUnit: payment.businessUnit ? {
      id: payment.businessUnit.id,
      name: payment.businessUnit.name,
      code: payment.businessUnit.code,
    } : undefined,
    payee: payment.connection ? {
      name: payment.connection.legalBusinessName || payment.connection.merchantName,
      mobile: payment.connection.mobile,
      upiId: payment.connection.upiId,
    } : undefined,
  };
  return {
    ...payload,
    payment_id: payload.id,
    order_id: payload.orderId,
    customer_name: payload.customerName,
    customer_mobile: payload.customerMobile,
    bank_rrn: payload.bankReferenceNo,
    payer_name: payload.payerName,
    payer_handle: payload.payerHandle,
    paid_at: payload.paidAt,
    redirect_url: payload.redirectUrl,
    checkout_url: checkoutUrl,
    qr_path: qrPath,
    expires_at: payload.expiresAt,
    created_at: payload.createdAt,
    business_unit: payload.businessUnit ? { ...payload.businessUnit } : undefined,
  };
}

module.exports = { createPayment, publicPayment };
