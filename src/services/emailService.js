const nodemailer = require('nodemailer');
const config = require('../config');
const { logger, safeError } = require('../lib/logger');

const transporter = config.smtp ? nodemailer.createTransport(config.smtp) : null;

async function sendActivationEmail({ email, name, activationUrl }) {
  if (!transporter) {
    logger.warn('SMTP is not configured; activation email was not delivered', { event: 'EMAIL_DEV_FALLBACK', email: maskEmail(email), emailType: 'activation' });
    return { delivered: false, developmentUrl: activationUrl };
  }
  const info = await deliverMail('activation', email, {
    from: config.emailFrom,
    to: email,
    subject: 'Activate your Pay-Panda account',
    text: `Hello ${name}, activate your Pay-Panda account: ${activationUrl}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px;color:#111827"><h1 style="font-size:24px">Activate Pay-Panda</h1><p>Hello ${escapeHtml(name)},</p><p>Verify your email and activate your workspace using the secure button below.</p><p><a href="${activationUrl}" style="display:inline-block;background:#6d4aff;color:white;padding:12px 20px;border-radius:9px;text-decoration:none;font-weight:700">Activate account</a></p><p style="color:#6b7280;font-size:13px">This link expires in ${config.emailVerificationHours} hours. You will confirm the password selected during signup.</p></div>`,
  });
  return { delivered: true, messageId: info.messageId };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

async function sendPasswordResetEmail({ email, name, resetUrl }) {
  if (!transporter) {
    logger.warn('SMTP is not configured; password reset email was not delivered', { event: 'EMAIL_DEV_FALLBACK', email: maskEmail(email), emailType: 'password-reset' });
    return { delivered: false, developmentUrl: resetUrl };
  }
  const info = await deliverMail('password-reset', email, {
    from: config.emailFrom,
    to: email,
    subject: 'Reset your Pay-Panda password',
    text: `Hello ${name}, reset your Pay-Panda password: ${resetUrl}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px;color:#111827"><h1 style="font-size:24px">Reset your password</h1><p>Hello ${escapeHtml(name)},</p><p>Use the secure button below to choose a new Pay-Panda password.</p><p><a href="${resetUrl}" style="display:inline-block;background:#6d4aff;color:white;padding:12px 20px;border-radius:9px;text-decoration:none;font-weight:700">Reset password</a></p><p style="color:#6b7280;font-size:13px">This single-use link expires in ${config.passwordResetMinutes} minutes. If you did not request it, you can ignore this email.</p></div>`,
  });
  return { delivered: true, messageId: info.messageId };
}

async function sendLoginOtpEmail({ email, name, otp }) {
  if (!transporter) {
    logger.warn('SMTP is not configured; login OTP was not delivered', { event: 'EMAIL_DEV_FALLBACK', email: maskEmail(email), emailType: 'login-otp' });
    return { delivered: false, developmentOtp: otp };
  }
  const info = await deliverMail('login-otp', email, {
    from: config.emailFrom,
    to: email,
    subject: `${otp} is your Pay-Panda login code`,
    text: `Hello ${name}, your Pay-Panda login code is ${otp}. It expires in ${config.loginOtpMinutes} minutes.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px;color:#111827"><h1 style="font-size:24px">Confirm your login</h1><p>Hello ${escapeHtml(name)},</p><p>Enter this one-time code to access Pay-Panda:</p><div style="font-size:34px;font-weight:800;letter-spacing:10px;padding:18px;background:#f3f0ff;border-radius:12px;text-align:center;color:#111827">${otp}</div><p style="color:#6b7280;font-size:13px;margin-top:16px">The code expires in ${config.loginOtpMinutes} minutes and can be attempted five times.</p></div>`,
  });
  return { delivered: true, messageId: info.messageId };
}

async function sendPaymentReceiptEmail({ email, customerName, businessName, amount, orderId, bankReferenceNo, paidAt }) {
  if (!transporter) {
    logger.warn('SMTP is not configured; payment receipt email was not delivered', { event: 'EMAIL_DEV_FALLBACK', email: maskEmail(email), emailType: 'payment-receipt' });
    return { delivered: false };
  }
  const amountText = `₹${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  const info = await deliverMail('payment-receipt', email, {
    from: config.emailFrom,
    to: email,
    subject: `Payment confirmed — ${amountText} to ${businessName}`,
    text: `Hello ${customerName || 'there'}, your payment of ${amountText} to ${businessName} (order ${orderId}) was received. Bank reference: ${bankReferenceNo || 'N/A'}.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px;color:#111827"><h1 style="font-size:24px">Payment confirmed</h1><p>Hello ${escapeHtml(customerName || 'there')},</p><p>Your payment to <strong>${escapeHtml(businessName)}</strong> has been received and confirmed.</p><div style="background:#f3f0ff;border-radius:12px;padding:18px;margin:16px 0"><p style="margin:0;font-size:13px;color:#6b7280">Amount paid</p><p style="margin:4px 0 0;font-size:28px;font-weight:800">${amountText}</p></div><table style="width:100%;font-size:13px;color:#374151"><tr><td style="padding:4px 0;color:#6b7280">Order ID</td><td style="padding:4px 0;text-align:right">${escapeHtml(orderId)}</td></tr><tr><td style="padding:4px 0;color:#6b7280">Bank reference</td><td style="padding:4px 0;text-align:right">${escapeHtml(bankReferenceNo || 'N/A')}</td></tr><tr><td style="padding:4px 0;color:#6b7280">Paid at</td><td style="padding:4px 0;text-align:right">${paidAt ? new Date(paidAt).toLocaleString() : 'N/A'}</td></tr></table><p style="color:#6b7280;font-size:12px;margin-top:20px">This is an automated receipt from Pay-Panda on behalf of ${escapeHtml(businessName)}.</p></div>`,
  });
  return { delivered: true, messageId: info.messageId };
}

async function sendPaymentReceivedEmail({ email, businessName, customerName, customerMobile, amount, orderId, bankReferenceNo, paidAt }) {
  if (!transporter) {
    logger.warn('SMTP is not configured; payment-received notification was not delivered', { event: 'EMAIL_DEV_FALLBACK', email: maskEmail(email), emailType: 'payment-received' });
    return { delivered: false };
  }
  const amountText = `₹${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  const payer = customerName || customerMobile || 'A customer';
  const info = await deliverMail('payment-received', email, {
    from: config.emailFrom,
    to: email,
    subject: `You received ${amountText} — order ${orderId}`,
    text: `${payer} paid ${amountText} for order ${orderId}. Bank reference: ${bankReferenceNo || 'N/A'}.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px;color:#111827"><h1 style="font-size:24px">New payment received</h1><p>Hello,</p><p><strong>${escapeHtml(payer)}</strong> just paid your business, ${escapeHtml(businessName)}.</p><div style="background:#ecfdf5;border-radius:12px;padding:18px;margin:16px 0"><p style="margin:0;font-size:13px;color:#065f46">Amount received</p><p style="margin:4px 0 0;font-size:28px;font-weight:800;color:#065f46">${amountText}</p></div><table style="width:100%;font-size:13px;color:#374151"><tr><td style="padding:4px 0;color:#6b7280">Order ID</td><td style="padding:4px 0;text-align:right">${escapeHtml(orderId)}</td></tr><tr><td style="padding:4px 0;color:#6b7280">Customer</td><td style="padding:4px 0;text-align:right">${escapeHtml(payer)}${customerMobile ? ` (${escapeHtml(customerMobile)})` : ''}</td></tr><tr><td style="padding:4px 0;color:#6b7280">Bank reference</td><td style="padding:4px 0;text-align:right">${escapeHtml(bankReferenceNo || 'N/A')}</td></tr><tr><td style="padding:4px 0;color:#6b7280">Paid at</td><td style="padding:4px 0;text-align:right">${paidAt ? new Date(paidAt).toLocaleString() : 'N/A'}</td></tr></table><p style="color:#6b7280;font-size:12px;margin-top:20px">Manage notification preferences from your Pay-Panda dashboard settings.</p></div>`,
  });
  return { delivered: true, messageId: info.messageId };
}

async function sendSecurityAlertEmail({ email, businessName, action, detail }) {
  if (!transporter) {
    logger.warn('SMTP is not configured; security alert email was not delivered', { event: 'EMAIL_DEV_FALLBACK', email: maskEmail(email), emailType: 'security-alert' });
    return { delivered: false };
  }
  const info = await deliverMail('security-alert', email, {
    from: config.emailFrom,
    to: email,
    subject: `Security alert: ${action}`,
    text: `${action} on your Pay-Panda account for ${businessName}. ${detail || ''} If this wasn't you, sign in and revoke access immediately.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px;color:#111827"><h1 style="font-size:22px;color:#991b1b">Security alert</h1><p>Hello,</p><p><strong>${escapeHtml(action)}</strong> on your Pay-Panda account for <strong>${escapeHtml(businessName)}</strong>.</p>${detail ? `<p style="color:#374151">${escapeHtml(detail)}</p>` : ''}<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px;margin:16px 0;color:#991b1b;font-size:13px">If this wasn't you, sign in to your Pay-Panda dashboard immediately and revoke access, then change your password.</div><p style="color:#6b7280;font-size:12px">This is an automated security notification and cannot be disabled.</p></div>`,
  });
  return { delivered: true, messageId: info.messageId };
}

function maskEmail(value) { return String(value).replace(/^(.{2}).*(@.*)$/, '$1***$2'); }

async function deliverMail(emailType, email, payload) {
  logger.info('Email delivery started', {
    event: 'EMAIL_SEND_START',
    email: maskEmail(email),
    emailType,
    from: config.emailFrom,
  });
  try {
    const info = await transporter.sendMail(payload);
    logger.info('Email delivered by SMTP provider', {
      event: 'EMAIL_SENT',
      email: maskEmail(email),
      emailType,
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
    });
    return info;
  } catch (error) {
    logger.error('Email delivery failed', {
      event: 'EMAIL_FAILED',
      email: maskEmail(email),
      emailType,
      ...safeError(error),
    });
    throw error;
  }
}

module.exports = {
  sendActivationEmail, sendPasswordResetEmail, sendLoginOtpEmail,
  sendPaymentReceiptEmail, sendPaymentReceivedEmail, sendSecurityAlertEmail,
};
