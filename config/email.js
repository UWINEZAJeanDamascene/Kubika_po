  const nodemailer = require('nodemailer');

// Import centralized configuration
const env = require('../src/config/environment');
const config = env.getConfig();
const emailConfig = config.email;

// ============================================
// ENVIRONMENT VALIDATION
// ============================================

const validateConfig = () => {
  const provider = emailConfig.provider;
  const missing = [];

  if (provider === 'gmail') {
    if (!emailConfig.gmailUser) missing.push('GMAIL_USER');
    if (!emailConfig.gmailAppPassword) missing.push('GMAIL_APP_PASSWORD');
  } else if (provider === 'resend') {
    if (!emailConfig.resendApiKey) missing.push('RESEND_API_KEY');
  } else {
    if (!emailConfig.smtpHost) missing.push('SMTP_HOST');
    if (!emailConfig.smtpUser) missing.push('SMTP_USER');
    if (!emailConfig.smtpPass) missing.push('SMTP_PASS');
  }

  if (!emailConfig.fromAddress && !emailConfig.gmailUser) {
    missing.push('EMAIL_FROM_ADDRESS');
  }

  if (missing.length > 0) {
    console.warn(`⚠️  Email config: missing env vars: ${missing.join(', ')}`);
  }

  return { provider, valid: missing.length === 0, missing };
};

// ============================================
// TRANSPORTER FACTORY
// ============================================

const createTransporter = () => {
  const { provider, valid } = validateConfig();
  const nodeEnv = config.server.env;

  // If configuration is invalid (missing credentials), return a safe no-op transporter
  if (!valid) {
    return {
      verify: async () => false,
      sendMail: async (mail) => {
        try {
          console.warn('[Mailer] Credentials missing, skipping email to', mail && mail.to);
        } catch (e) {
          console.warn('[Mailer] Credentials missing, skipping email');
        }
        return Promise.resolve({ accepted: [], rejected: [], envelope: mail && mail.envelope ? mail.envelope : {}, messageId: 'skipped' });
      }
    };
  }

  const poolDefaults = {
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    rateLimit: 10, // max 10 messages/sec (Gmail limit ≈ 20/sec)
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    logger: nodeEnv === 'development',
    debug: nodeEnv === 'development'
  };

  if (provider === 'gmail') {
    return nodemailer.createTransport({
      ...poolDefaults,
      service: 'gmail',
      family: 4,
      auth: {
        user: emailConfig.gmailUser,
        pass: emailConfig.gmailAppPassword
      }
    });
  }

  if (provider === 'resend') {
    return nodemailer.createTransport({
      ...poolDefaults,
      host: 'smtp.resend.com',
      port: 465,
      secure: true,
      auth: {
        user: 'resend',
        pass: emailConfig.resendApiKey
      }
    });
  }

  // Fallback: generic SMTP
  const port = emailConfig.smtpPort;
  return nodemailer.createTransport({
    ...poolDefaults,
    host: emailConfig.smtpHost,
    port,
    secure: port === 465,
    auth: {
      user: emailConfig.smtpUser,
      pass: emailConfig.smtpPass
    }
  });
};

let transporter = null;

/**
 * Lazily get or create the transporter singleton.
 * Avoids crashes if env vars are loaded late (e.g. dotenv in server.js).
 */
const getTransporter = () => {
  if (!transporter) {
    transporter = createTransporter();
  }
  return transporter;
};

/**
 * Verify SMTP connection. Safe to call at server startup.
 * Returns true/false — never throws.
 */
const testConnection = async () => {
  try {
    const { provider } = validateConfig();
    const t = getTransporter();
    await t.verify();
    console.log(`✅ Email server connected (provider: ${provider})`);
    return true;
  } catch (error) {
    const { provider } = validateConfig();
    console.error(`❌ Email server error [${provider}]:`, error.message);
    return false;
  }
};

module.exports = { getTransporter, testConnection, validateConfig };
