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

async function sendLoginOtpEmail({ email, name, otp, copyToken }) {
  if (!transporter) {
    logger.warn('SMTP is not configured; login OTP was not delivered', { event: 'EMAIL_DEV_FALLBACK', email: maskEmail(email), emailType: 'login-otp' });
    return { delivered: false, developmentOtp: otp };
  }
  const info = await deliverMail('login-otp', email, {
    from: config.emailFrom,
    to: email,
    subject: `${otp} is your Pay-Panda login code`,
    text: `Hello ${name}, your Pay-Panda login code is ${otp}. It expires in ${config.loginOtpMinutes} minutes.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px;color:#111827"><h1 style="font-size:24px">Confirm your login</h1><p>Hello ${escapeHtml(name)},</p><p>Enter this one-time code to access Pay-Panda:</p><div style="font-size:34px;font-weight:800;letter-spacing:10px;padding:18px;background:#f3f0ff;border-radius:12px;text-align:center;color:#111827;user-select:all;-webkit-user-select:all">${otp}</div><p style="text-align:center"><a href="${config.frontendUrl}/copy-otp?t=${copyToken}" style="display:inline-block;background:#6d4aff;color:white;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none">Copy code</a></p><p style="color:#6b7280;font-size:13px;margin-top:16px">The code expires in ${config.loginOtpMinutes} minutes and can be attempted five times.</p></div>`,
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

module.exports = { sendActivationEmail, sendPasswordResetEmail, sendLoginOtpEmail };
