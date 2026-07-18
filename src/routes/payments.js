const express = require('express');
const { z } = require('zod');
const prisma = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { requireApiAuth, requireDashboardAuth } = require('../middleware/auth');
const { createPayment, publicPayment } = require('../services/paymentService');

const router = express.Router();
const schema = z.object({
  order_id: z.string().min(1).max(100), amount: z.coerce.number().positive().max(1000000),
  customer_name: z.string().max(100).optional(), customer_mobile: z.string().regex(/^\d{6,15}$/, 'Enter a valid mobile number (6 to 15 digits, no country code).').optional(),
  reason: z.string().max(180).optional(), remark1: z.string().max(200).optional(),
  remark2: z.string().max(200).optional(), redirect_url: z.url().optional(), connection_id: z.string().optional(),
  business_unit_id: z.string().optional(), business_unit_code: z.string().max(60).optional(),
  expires_in_minutes: z.coerce.number().int().min(1).max(60).optional(),
});

router.post('/v1/payments', requireApiAuth, asyncHandler(async (req, res) => {
  const input = schema.parse(req.body);
  const { payment, created } = await createPayment(req.auth.businessId, map(input), 'API');
  res.status(created ? 201 : 200).json({ success: true, payment: publicPayment(payment) });
}));

router.post('/dashboard/payments', requireDashboardAuth, asyncHandler(async (req, res) => {
  const input = schema.parse(req.body);
  const { payment, created } = await createPayment(req.auth.businessId, map(input), 'DASHBOARD');
  res.status(created ? 201 : 200).json({ success: true, payment: publicPayment(payment) });
}));

router.post('/v1/payments/verify', requireApiAuth, asyncHandler(async (req, res) => {
  const input = z.object({
    payment_id: z.string().min(10).optional(),
    pay_panda_payment_id: z.string().min(10).optional(),
    order_id: z.string().min(1).max(100).optional(),
    amount: z.coerce.number().positive().optional(),
    customer_mobile: z.string().optional(),
  }).refine(value => value.payment_id || value.pay_panda_payment_id || value.order_id, { message: 'Provide payment_id, pay_panda_payment_id or order_id.' }).parse(req.body);
  const paymentId = input.payment_id || input.pay_panda_payment_id;
  let payment = await prisma.payment.findFirst({ where: {
    businessId: req.auth.businessId,
    ...(paymentId ? { publicId: paymentId } : {}),
    ...(input.order_id ? { clientOrderId: input.order_id } : {}),
  }, include: { businessUnit: true, connection: true } });
  if (!payment) return res.status(404).json({ success: false, verified: false, message: 'No payment belonging to this OAuth application matches the supplied identifier.' });
  if (payment.status === 'PENDING' && payment.expiresAt <= new Date()) payment = await prisma.payment.update({ where: { id: payment.id }, data: { status: 'EXPIRED' }, include: { businessUnit: true, connection: true } });

  // Strict amount cross-check: some UPI apps let the payer edit the amount before paying, or a
  // merchant could look up the wrong order by mistake. When the merchant supplies the amount
  // they originally requested, require it to match the stored payment to the paisa — never
  // trust status alone. This runs even on an already-SUCCESS payment, so a mismatched
  // transaction can never be reported as verified just because *some* payment with that
  // id/order happened to succeed. Zero tolerance beyond float-rounding to the nearest paisa.
  const amountMismatch = input.amount !== undefined && Math.round(Number(payment.amount) * 100) !== Math.round(input.amount * 100);

  // Mobile is informational only, not a hard gate: the number entered at checkout is a contact
  // field, not necessarily the UPI handle's registered number (family member's account, a
  // different linked number, etc.), so a mismatch alone shouldn't fail an otherwise-good payment.
  const mobileMatched = !input.customer_mobile || !payment.customerMobile
    ? null
    : normalizeMobile(input.customer_mobile) === normalizeMobile(payment.customerMobile);

  res.json({
    success: true,
    verified: payment.status === 'SUCCESS' && !amountMismatch,
    ...(amountMismatch ? { code: 'AMOUNT_MISMATCH', message: 'The paid amount does not match the amount you requested. Do not treat this as verified.' } : {}),
    ...(mobileMatched !== null ? { mobileMatched } : {}),
    payment: publicPayment(payment),
  });
}));

router.get('/v1/payments/:orderId', requireApiAuth, asyncHandler(async (req, res) => {
  let payment = await prisma.payment.findUnique({ where: {
    businessId_clientOrderId: { businessId: req.auth.businessId, clientOrderId: req.params.orderId },
  }, include: { businessUnit: true, connection: true }});
  if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
  if (payment.status === 'PENDING' && payment.expiresAt <= new Date()) payment = await prisma.payment.update({ where: { id: payment.id }, data: { status: 'EXPIRED' }, include: { businessUnit: true, connection: true } });
  res.json({ success: true, payment: publicPayment(payment) });
}));

router.get('/v1/payments/id/:paymentId', requireApiAuth, asyncHandler(async (req, res) => {
  let payment = await prisma.payment.findFirst({ where: { publicId: req.params.paymentId, businessId: req.auth.businessId }, include: { businessUnit: true, connection: true } });
  if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
  if (payment.status === 'PENDING' && payment.expiresAt <= new Date()) payment = await prisma.payment.update({ where: { id: payment.id }, data: { status: 'EXPIRED' }, include: { businessUnit: true, connection: true } });
  res.json({ success: true, payment: publicPayment(payment) });
}));

function normalizeMobile(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function map(input) {
  return {
    orderId: input.order_id, amount: input.amount, customerName: input.customer_name,
    customerMobile: input.customer_mobile, reason: input.reason, remark1: input.remark1,
    remark2: input.remark2, redirectUrl: input.redirect_url, connectionId: input.connection_id,
    businessUnitId: input.business_unit_id, businessUnitCode: input.business_unit_code,
    expiresInMinutes: input.expires_in_minutes,
  };
}

module.exports = router;
