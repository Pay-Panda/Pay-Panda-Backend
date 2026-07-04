const express = require('express');
const { z } = require('zod');
const prisma = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { encrypt, decrypt } = require('../lib/crypto');
const { requireDashboardAuth } = require('../middleware/auth');
const bharatpe = require('../providers/bharatpe');
const { syncConnection } = require('../services/poller');
const { logger } = require('../lib/logger');

const router = express.Router();
router.use(requireDashboardAuth);

const safe = connection => ({ ...connection, encryptedToken: undefined, qrImage: undefined, rawMerchantData: undefined });

router.get('/', asyncHandler(async (req, res) => {
  const connections = await prisma.merchantConnection.findMany({ where: { businessId: req.auth.businessId }, orderBy: { createdAt: 'desc' } });
  res.json({ success: true, connections: connections.map(safe) });
}));

router.post('/bharatpe', asyncHandler(async (req, res) => {
  const input = z.object({ mobile: z.string().min(10).max(15), token: z.string().min(16), label: z.string().max(80).optional() }).parse(req.body);
  logger.info('BharatPe connection verification started', { event: 'CONNECTION_START', requestId: req.id, businessId: req.auth.businessId, mobile: maskMobile(input.mobile), label: input.label });
  const merchant = await bharatpe.getMerchantInfo(input.token);
  const accountInfo = await bharatpe.getAccountInfo(input.token);
  logger.info('BharatPe merchant profile verified', { event: 'MERCHANT_VERIFIED', requestId: req.id, businessId: req.auth.businessId, merchantId: String(merchant.merchantId), businessName: merchant.businessName, status: merchant.status });
  const enteredMobile = normalizeMobile(input.mobile);
  const merchantMobile = normalizeMobile(merchant.mobile);
  if (!enteredMobile || !merchantMobile || enteredMobile !== merchantMobile) {
    logger.warn('BharatPe registered mobile did not match', { event: 'MERCHANT_MOBILE_MISMATCH', requestId: req.id, businessId: req.auth.businessId, enteredMobile: maskMobile(enteredMobile), merchantMobile: maskMobile(merchantMobile), merchantId: String(merchant.merchantId) });
    return res.status(400).json({
      success: false,
      code: 'MERCHANT_MOBILE_MISMATCH',
      message: `The entered mobile number does not match the BharatPe account linked to this token. Enter the registered number ending in ${merchantMobile ? merchantMobile.slice(-4) : 'the number shown in BharatPe'}.`,
    });
  }
  const { qrUrl, image } = await bharatpe.downloadMerchantQr(input.token, merchant.merchantId);
  logger.info('BharatPe merchant QR downloaded', { event: 'MERCHANT_QR_DOWNLOADED', requestId: req.id, businessId: req.auth.businessId, merchantId: String(merchant.merchantId), imageBytes: image.length });
  const baseUpiIntent = await bharatpe.decodeQr(image);
  const upiId = bharatpe.extractUpiId(baseUpiIntent);
  logger.info('Merchant QR decoded successfully', { event: 'MERCHANT_QR_DECODED', requestId: req.id, businessId: req.auth.businessId, merchantId: String(merchant.merchantId), upiId });
  const existingOwner = await prisma.merchantConnection.findUnique({
    where: { provider_merchantId: { provider: 'BHARATPE', merchantId: String(merchant.merchantId) } },
    select: { businessId: true },
  });
  if (existingOwner && existingOwner.businessId !== req.auth.businessId) {
    return res.status(409).json({ success: false, message: 'This BharatPe merchant is already connected to another Pay-Panda workspace' });
  }
  const duplicateMobile = await prisma.merchantConnection.findFirst({ where: {
    businessId: req.auth.businessId, provider: 'BHARATPE', mobile: enteredMobile,
    status: 'ACTIVE', merchantId: { not: String(merchant.merchantId) },
  }});
  if (duplicateMobile) return res.status(409).json({
    success: false,
    message: 'This mobile number already has an active BharatPe connection. Deactivate it before connecting another merchant.',
  });
  const count = await prisma.merchantConnection.count({ where: { businessId: req.auth.businessId } });
  const account = String(merchant.accountNumber || merchant.bankInfo?.accountNumber || '');
  const connection = await prisma.merchantConnection.upsert({
    where: { provider_merchantId: { provider: 'BHARATPE', merchantId: String(merchant.merchantId) } },
    update: {
      businessId: req.auth.businessId, mobile: enteredMobile, encryptedToken: encrypt(input.token), status: 'ACTIVE', deactivatedAt: null,
      label: input.label, legalBusinessName: merchant.businessName, merchantName: merchant.merchantName,
      category: merchant.categoryDisplayName || merchant.bussinessCategory, subCategory: merchant.subCategoryDisplayName || merchant.subCategory,
      merchantMid: merchant.mid, kycType: merchant.kycType, merchantType: merchant.merchantType,
      merchantPaymentType: merchant.merchantPaymentType, beneficiaryName: merchant.beneficiaryName || merchant.bankInfo?.beneficiaryName,
      bankName: merchant.bankInfo?.bankName, maskedAccountNumber: account ? `••••${account.slice(-4)}` : null,
      ifsc: merchant.ifsc || merchant.bankInfo?.ifsc, upiId, baseUpiIntent, providerQrUrl: qrUrl,
      qrImage: image, rawMerchantData: { merchant, account: accountInfo }, lastConnectedAt: new Date(), lastError: null,
      autoSettlement: Boolean(accountInfo.auto_settlement),
    },
    create: {
      businessId: req.auth.businessId, provider: 'BHARATPE', mobile: enteredMobile,
      encryptedToken: encrypt(input.token), status: 'ACTIVE', label: input.label,
      merchantId: String(merchant.merchantId), merchantMid: merchant.mid,
      legalBusinessName: merchant.businessName, merchantName: merchant.merchantName,
      category: merchant.categoryDisplayName || merchant.bussinessCategory, subCategory: merchant.subCategoryDisplayName || merchant.subCategory,
      kycType: merchant.kycType, merchantType: merchant.merchantType, merchantPaymentType: merchant.merchantPaymentType,
      beneficiaryName: merchant.beneficiaryName || merchant.bankInfo?.beneficiaryName, bankName: merchant.bankInfo?.bankName,
      maskedAccountNumber: account ? `••••${account.slice(-4)}` : null, ifsc: merchant.ifsc || merchant.bankInfo?.ifsc,
      upiId, baseUpiIntent, providerQrUrl: qrUrl, qrImage: image, rawMerchantData: { merchant, account: accountInfo },
      lastConnectedAt: new Date(), isDefault: count === 0,
      autoSettlement: Boolean(accountInfo.auto_settlement),
    },
  });
  logger.info('BharatPe connection activated', { event: 'CONNECTION_ACTIVE', requestId: req.id, businessId: req.auth.businessId, connectionId: connection.id, merchantId: connection.merchantId, mobile: maskMobile(connection.mobile), isDefault: connection.isDefault });
  res.status(201).json({ success: true, connection: safe(connection) });
}));

router.post('/:id/refresh-details', asyncHandler(async (req, res) => {
  const item = await prisma.merchantConnection.findFirst({ where: { id: req.params.id, businessId: req.auth.businessId } });
  if (!item) return res.status(404).json({ success: false, message: 'Connection not found' });
  const accountInfo = await bharatpe.getAccountInfo(decrypt(item.encryptedToken));
  const connection = await prisma.merchantConnection.update({ where: { id: item.id }, data: {
    autoSettlement: Boolean(accountInfo.auto_settlement), lastConnectedAt: new Date(),
    rawMerchantData: { ...(item.rawMerchantData || {}), account: accountInfo },
  }});
  logger.info('Merchant account details refreshed', { event: 'CONNECTION_REFRESHED', requestId: req.id, businessId: req.auth.businessId, connectionId: item.id, autoSettlement: connection.autoSettlement });
  res.json({ success: true, connection: safe(connection) });
}));

router.post('/:id/deactivate', asyncHandler(async (req, res) => {
  const item = await prisma.merchantConnection.findFirst({ where: { id: req.params.id, businessId: req.auth.businessId } });
  if (!item) return res.status(404).json({ success: false, message: 'Connection not found' });
  const connection = await prisma.merchantConnection.update({ where: { id: item.id }, data: {
    status: 'DISABLED', isDefault: false, deactivatedAt: new Date(),
  }});
  logger.warn('Merchant connection deactivated', { event: 'CONNECTION_DEACTIVATED', requestId: req.id, businessId: req.auth.businessId, connectionId: item.id, merchantId: item.merchantId });
  res.json({ success: true, connection: safe(connection) });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const item = await prisma.merchantConnection.findFirst({ where: { id: req.params.id, businessId: req.auth.businessId }, include: { _count: { select: { payments: true } } } });
  if (!item) return res.status(404).json({ success: false, message: 'Connection not found' });
  if (item._count.payments > 0) return res.status(409).json({ success: false, message: 'This connection has payment history and cannot be deleted. Deactivate it instead.' });
  await prisma.merchantConnection.delete({ where: { id: item.id } });
  logger.warn('Unused merchant connection deleted', { event: 'CONNECTION_DELETED', requestId: req.id, businessId: req.auth.businessId, connectionId: item.id, merchantId: item.merchantId });
  res.json({ success: true });
}));

router.get('/:id/qr', asyncHandler(async (req, res) => {
  const item = await prisma.merchantConnection.findFirst({ where: { id: req.params.id, businessId: req.auth.businessId }, select: { qrImage: true } });
  if (!item?.qrImage) return res.status(404).json({ success: false, message: 'QR not found' });
  res.type('png').set('Cache-Control', 'private, no-store').send(Buffer.from(item.qrImage));
}));

router.post('/:id/sync', asyncHandler(async (req, res) => {
  const item = await prisma.merchantConnection.findFirst({ where: { id: req.params.id, businessId: req.auth.businessId } });
  if (!item) return res.status(404).json({ success: false, message: 'Connection not found' });
  await syncConnection(item);
  logger.info('Manual merchant synchronization completed', { event: 'CONNECTION_SYNC', requestId: req.id, businessId: req.auth.businessId, connectionId: item.id, merchantId: item.merchantId });
  res.json({ success: true });
}));

module.exports = router;

function normalizeMobile(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function maskMobile(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `******${digits.slice(-4)}` : 'unknown';
}
