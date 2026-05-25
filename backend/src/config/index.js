require('dotenv').config();

const config = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT, 10) || 3001,

  // Twilio
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER,

  // Vapi
  VAPI_API_KEY: process.env.VAPI_API_KEY,
  VAPI_ASSISTANT_ID: process.env.VAPI_ASSISTANT_ID,


  // Public base URL for webhooks
  BASE_URL: process.env.BASE_URL || 'http://localhost:3001',

  // SQL Server
  DB_SERVER: process.env.DB_SERVER,
  DB_NAME: process.env.DB_NAME,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD,
  DB_PORT: parseInt(process.env.DB_PORT, 10) || 1433,

  // Email (SMTP)
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: parseInt(process.env.SMTP_PORT, 10) || 587,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  EMAIL_FROM: process.env.EMAIL_FROM || 'Culture Holidays <noreply@cultureholidays.com>',

  // Portal URLs (used in link-sending tools)
  AGENT_REGISTRATION_URL: process.env.AGENT_REGISTRATION_URL || 'https://cultureholidays.com/agent-register',

  // Human support ring — comma-separated E.164 numbers, all ring simultaneously
  SUPPORT_NUMBERS: (process.env.SUPPORT_NUMBERS || '').split(',').map(n => n.trim()).filter(Boolean),

  // Fallback phone used for Vapi dashboard/web test calls (no real inbound number).
  // Set this to a verified agent's number so identity lookup works during testing.
  TEST_CALLER_PHONE: process.env.TEST_CALLER_PHONE || null,
};

const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'VAPI_API_KEY'];
const missing = required.filter((key) => !config[key]);
if (missing.length > 0 && config.NODE_ENV === 'production') {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

module.exports = config;
