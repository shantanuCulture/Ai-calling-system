const { getTwilioClient } = require('../integrations/twilio');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Sends a package summary SMS to the customer.
 * Twilio SMS has a 1600-char limit so we send a concise version with the booking link.
 */
const sendPackageSMS = async ({ to, customerName, packages }) => {
  const client = getTwilioClient();

  // TRIAL ACCOUNT WORKAROUND: send only the first package with its PDF link
  // so the message stays under 160 chars and passes carrier filters.
  // TODO: remove this limit on live — send all packages with links.
  const pkg = packages[0];
  const pdf = pkg?.availableDates?.[0]?.pdfUrl || pkg?.availableDates?.[0]?.bookingLink || null;
  const linkPart = pdf ? ` ${pdf}` : '';
  const body = `Culture Holidays package for ${customerName || 'you'}: ${pkg?.title} (${pkg?.durationDays}D).${linkPart}`;

  const msg = await client.messages.create({
    to,
    from: config.TWILIO_PHONE_NUMBER,
    body: body.substring(0, 1560),
  });

  logger.info(`SMS sent to ${to}: ${msg.sid}`);
  return msg;
};

const sendBookingLinkSMS = async ({ to, customerName, bookingUrl }) => {
  const client = getTwilioClient();
  const body = `Hi ${customerName || 'there'}! Your Culture Holidays booking link: ${bookingUrl} — Complete your booking now. Call us if you need help.`;
  const msg = await client.messages.create({ to, from: config.TWILIO_PHONE_NUMBER, body: body.substring(0, 1600) });
  logger.info(`Booking link SMS sent to ${to}: ${msg.sid}`);
  return msg;
};

const sendPaymentLinkSMS = async ({ to, customerName, paymentUrl, amount }) => {
  const client = getTwilioClient();
  const amountPart = amount ? ` Amount: ${amount}.` : '';
  const body = `Hi ${customerName || 'there'}! Culture Holidays payment link:${amountPart} ${paymentUrl} — Secure payment. Do not share this link.`;
  const msg = await client.messages.create({ to, from: config.TWILIO_PHONE_NUMBER, body: body.substring(0, 1600) });
  logger.info(`Payment link SMS sent to ${to}: ${msg.sid}`);
  return msg;
};

const sendRegistrationLinkSMS = async ({ to, registrationUrl }) => {
  const client = getTwilioClient();
  const body = `Welcome to Culture Holidays! Complete your agent registration here: ${registrationUrl}`;
  const msg = await client.messages.create({ to, from: config.TWILIO_PHONE_NUMBER, body: body.substring(0, 1600) });
  logger.info(`Registration link SMS sent to ${to}: ${msg.sid}`);
  return msg;
};

const sendGenericSMS = async ({ to, body }) => {
  const client = getTwilioClient();
  const msg = await client.messages.create({
    to,
    from: config.TWILIO_PHONE_NUMBER,
    body: body.substring(0, 1600),
  });
  logger.info(`SMS sent to ${to}: ${msg.sid}`);
  return msg;
};

module.exports = { sendPackageSMS, sendBookingLinkSMS, sendPaymentLinkSMS, sendRegistrationLinkSMS, sendGenericSMS };
