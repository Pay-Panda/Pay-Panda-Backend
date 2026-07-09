const config = require('../config');

function buildFrontendUrl(req, pathname, token) {
  const configuredOrigins = [config.publicAppUrl, config.frontendUrl].map(validOrigin).filter(Boolean);
  const requestOrigin = validOrigin(req.get('origin'));
  const trustedRequestOrigin = requestOrigin && configuredOrigins.includes(requestOrigin) ? requestOrigin : null;
  const candidates = [trustedRequestOrigin, ...configuredOrigins];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const target = new URL(pathname, `${candidate}/`);
    target.searchParams.set('token', token);
    return target.toString();
  }
  throw Object.assign(new Error('A valid frontend base URL is not configured'), { statusCode: 500 });
}

function validOrigin(value) {
  if (!value || value === '*' || value === 'null') return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.hostname === '*') return null;
    return url.origin;
  } catch { return null; }
}

module.exports = { buildFrontendUrl, validOrigin };
