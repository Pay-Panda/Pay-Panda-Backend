const express = require('express');
const prisma = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { publicPayment } = require('../services/paymentService');
const { syncPublicPayment } = require('../services/poller');

const router = express.Router();

router.get('/payments/:publicId', asyncHandler(async (req, res) => {
  let payment = await prisma.payment.findUnique({ where: { publicId: req.params.publicId }, include: { business: true, connection: true } });
  if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
  if (payment.status === 'PENDING' && payment.expiresAt <= new Date()) {
    payment = await prisma.payment.update({ where: { id: payment.id }, data: { status: 'EXPIRED' }, include: { business: true, connection: true } });
  }
  if (payment.status === 'PENDING') {
    await syncPublicPayment(payment.publicId);
    payment = await prisma.payment.findUnique({ where: { publicId: req.params.publicId }, include: { business: true, connection: true } });
  }
  res.set('Cache-Control', 'no-store').json({ success: true, payment: {
    ...publicPayment(payment), business: { name: payment.business.name, theme: payment.business.theme, logoPath: payment.business.logoPath },
  }});
}));

router.get('/payments/:publicId/qr', asyncHandler(async (req, res) => {
  const payment = await prisma.payment.findUnique({ where: { publicId: req.params.publicId }, select: { qrImage: true } });
  if (!payment) return res.status(404).send('Payment not found');
  res.type('png').set('Cache-Control', 'private, no-store').send(Buffer.from(payment.qrImage));
}));

module.exports = router;
