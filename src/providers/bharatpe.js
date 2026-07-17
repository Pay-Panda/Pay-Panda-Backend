const axios = require('axios');
const sharp = require('sharp');
const jsQR = require('jsqr');

const merchantApi = axios.create({ baseURL: 'https://api-merchant.bharatpe.in', timeout: 15000 });
const paymentsApi = axios.create({ baseURL: 'https://payments-tesseract.bharatpe.in', timeout: 15000 });
const accountApi = axios.create({ baseURL: 'https://api-deposit.bharatpe.in', timeout: 15000 });

const headers = token => ({
  token,
  accept: 'application/json, text/plain, */*',
  'user-agent': 'Pay-Panda/1.0',
});

async function getMerchantInfo(token) {
  const { data } = await merchantApi.get('/merchant/v3/getmerchantinfo', { headers: headers(token) });
  if (!data?.status || !data?.data?.merchantId) throw new Error(data?.message || 'BharatPe merchant lookup failed');
  return data.data;
}

async function downloadMerchantQr(token, merchantId) {
  const { data } = await paymentsApi.get('/api/merchant/v1/downloadQr', {
    params: { merchantId }, headers: headers(token),
  });
  if (!data?.status || !data?.data?.url) throw new Error(data?.message || 'BharatPe QR lookup failed');
  const image = await axios.get(data.data.url, { responseType: 'arraybuffer', timeout: 15000 });
  return { qrUrl: data.data.url, image: Buffer.from(image.data) };
}

async function getAccountInfo(token) {
  const { data } = await accountApi.get('/bharatpe-account/v1/account', { headers: headers(token) });
  if (!data?.success || !data?.data) throw new Error(data?.message || 'BharatPe account lookup failed');
  return data.data;
}

async function decodeQr(image) {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  if (!decoded?.data) throw new Error('Could not decode the BharatPe QR image');
  return decoded.data;
}

function extractUpiId(intent) {
  const query = intent.includes('?') ? intent.slice(intent.indexOf('?') + 1) : '';
  const upiId = new URLSearchParams(query).get('pa');
  if (!upiId) throw new Error('The decoded QR does not contain a UPI payee address');
  return upiId;
}

function createPaymentIntent(baseIntent, { amount, reason, remark1, remark2, clientOrderId }) {
  const query = baseIntent.includes('?') ? baseIntent.slice(baseIntent.indexOf('?') + 1) : '';
  const params = new URLSearchParams(query);
  const note = [remark1, remark2, reason].map(cleanNotePart).filter(Boolean).join(' - ') || `Payment ${clientOrderId}`;
  params.set('am', Number(amount).toFixed(2));
  params.set('cu', 'INR');
  params.set('tn', note.slice(0, 120));
  params.set('tr', clientOrderId);
  return `upi://pay?${params.toString()}`;
}

function cleanNotePart(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function getTransactions(token, { merchantId, startMs, endMs, pageSize = 50 }) {
  const { data } = await paymentsApi.get('/api/v1/merchant/transactions', {
    params: {
      module: 'PAYMENT_QR', merchantId, sDate: startMs, eDate: endMs,
      pageSize, pageCount: 0, isFromOtDashboard: 1,
    },
    headers: { ...headers(token), Referer: 'https://enterprise.bharatpe.in/' },
  });
  if (!data?.status) throw new Error(data?.message || 'BharatPe transaction lookup failed');
  return data?.data?.transactions || [];
}

module.exports = { getMerchantInfo, getAccountInfo, downloadMerchantQr, decodeQr, extractUpiId, createPaymentIntent, getTransactions };
