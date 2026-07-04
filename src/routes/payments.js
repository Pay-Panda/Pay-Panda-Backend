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

router.get('/v1/payments/:orderId', requireApiAuth, asyncHandler(async (req, res) => {
  let payment = await prisma.payment.findUnique({ where: {
    businessId_clientOrderId: { businessId: req.auth.businessId, clientOrderId: req.params.orderId },
  }});
  if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
  if (payment.status === 'PENDING' && payment.expiresAt <= new Date()) payment = await prisma.payment.update({ where: { id: payment.id }, data: { status: 'EXPIRED' } });
  res.json({ success: true, payment: publicPayment(payment) });
}));

router.get('/v1/payments/id/:paymentId', requireApiAuth, asyncHandler(async (req, res) => {
  let payment = await prisma.payment.findFirst({ where: { publicId: req.params.paymentId, businessId: req.auth.businessId } });
  if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
  if (payment.status === 'PENDING' && payment.expiresAt <= new Date()) payment = await prisma.payment.update({ where: { id: payment.id }, data: { status: 'EXPIRED' } });
  res.json({ success: true, payment: publicPayment(payment) });
}));

function map(input) {
  return {
    orderId: input.order_id, amount: input.amount, customerName: input.customer_name,
    customerMobile: input.customer_mobile, reason: input.reason, remark1: input.remark1,
    remark2: input.remark2, redirectUrl: input.redirect_url, connectionId: input.connection_id,
    expiresInMinutes: input.expires_in_minutes,
  };
}

module.exports = router;
