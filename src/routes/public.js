const express = require('express');
const QRCode = require('qrcode');
const { z } = require('zod');
const prisma = require('../db');
const config = require('../config');
const asyncHandler = require('../lib/asyncHandler');
const { createPayment, publicPayment } = require('../services/paymentService');
const { syncPublicPayment } = require('../services/poller');

const router = express.Router();

router.get('/payments/:publicId', asyncHandler(async (req, res) => {
  let payment = await prisma.payment.findUnique({ where: { publicId: req.params.publicId }, include: { business: true, businessUnit: true, connection: true } });
  if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
  if (payment.status === 'PENDING' && payment.expiresAt <= new Date()) {
    payment = await prisma.payment.update({ where: { id: payment.id }, data: { status: 'EXPIRED' }, include: { business: true, businessUnit: true, connection: true } });
  }
  if (payment.status === 'PENDING') {
    await syncPublicPayment(payment.publicId);
    payment = await prisma.payment.findUnique({ where: { publicId: req.params.publicId }, include: { business: true, businessUnit: true, connection: true } });
  }
  res.set('Cache-Control', 'no-store').json({ success: true, payment: {
    ...publicPayment(payment), business: { name: payment.businessUnit?.name || payment.business.name, parentName: payment.business.name, theme: payment.business.theme, checkoutLayout: payment.business.checkoutLayout, logoPath: payment.business.logoPath },
  }});
}));

router.get('/payments/:publicId/qr', asyncHandler(async (req, res) => {
  const payment = await prisma.payment.findUnique({ where: { publicId: req.params.publicId }, select: { qrImage: true } });
  if (!payment) return res.status(404).send('Payment not found');
  res.type('png').set('Cache-Control', 'private, no-store').send(Buffer.from(payment.qrImage));
}));

router.get('/link/:slug', asyncHandler(async (req, res) => {
  const link = await prisma.defaultLink.findUnique({ where: { slug: req.params.slug }, include: { business: true } });
  if (!link || !link.active) return res.status(404).json({ success: false, message: 'This payment link is not available.' });
  if (link.business.suspendedAt) return res.status(403).json({ success: false, message: 'This account has been suspended. Contact support.' });
  res.json({ success: true, link: {
    label: link.label, minAmount: link.minAmount ? Number(link.minAmount) : null, maxAmount: link.maxAmount ? Number(link.maxAmount) : null,
    business: { name: link.business.name, theme: link.business.theme, logoPath: link.business.logoPath },
  }});
}));

router.get('/link/:slug/qr', asyncHandler(async (req, res) => {
  const link = await prisma.defaultLink.findUnique({ where: { slug: req.params.slug }, select: { active: true } });
  if (!link || !link.active) return res.status(404).send('Link not found');
  const png = await QRCode.toBuffer(`${config.publicAppUrl}/pay/link/${req.params.slug}`, { type: 'png', width: 320, margin: 2 });
  res.type('png').set('Cache-Control', 'public, max-age=3600').send(png);
}));

router.post('/link/:slug/pay', asyncHandler(async (req, res) => {
  const link = await prisma.defaultLink.findUnique({ where: { slug: req.params.slug }, include: { business: true } });
  if (!link || !link.active) return res.status(404).json({ success: false, message: 'This payment link is not available.' });
  if (link.business.suspendedAt) return res.status(403).json({ success: false, message: 'This account has been suspended. Contact support.' });
  const input = z.object({
    amount: z.coerce.number().positive().max(1000000),
    customer_name: z.string().max(100).optional(),
    customer_mobile: z.string().regex(/^\d{6,15}$/, 'Enter a valid mobile number.').optional(),
  }).parse(req.body);
  if (link.minAmount && input.amount < Number(link.minAmount)) return res.status(400).json({ success: false, message: `Minimum amount is ₹${Number(link.minAmount).toFixed(2)}.` });
  if (link.maxAmount && input.amount > Number(link.maxAmount)) return res.status(400).json({ success: false, message: `Maximum amount is ₹${Number(link.maxAmount).toFixed(2)}.` });
  const orderId = `LINK-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { payment } = await createPayment(link.businessId, {
    orderId, amount: input.amount, customerName: input.customer_name, customerMobile: input.customer_mobile,
    reason: link.label || 'Payment',
  }, 'DEFAULT_LINK');
  res.status(201).json({ success: true, payment: publicPayment(payment) });
}));

module.exports = router;
