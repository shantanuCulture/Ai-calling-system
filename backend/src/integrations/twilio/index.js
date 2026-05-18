const twilio = require('twilio');
const config = require('../../config');
const logger = require('../../utils/logger');

let client = null;

/**
 * Returns a singleton Twilio client.
 * Lazily initialized so the server can boot without credentials in dev mode.
 */
const getTwilioClient = () => {
  if (client) return client;

  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) {
    throw new Error('Twilio credentials are not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env');
  }

  client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
  logger.info('Twilio client initialized');
  return client;
};

module.exports = { getTwilioClient };
