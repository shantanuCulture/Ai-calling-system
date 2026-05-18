const nodemailer = require('nodemailer');
const config = require('../config');
const logger = require('../utils/logger');

let transporter = null;

const getTransporter = () => {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
  });
  return transporter;
};

/**
 * Sends package details to the customer.
 * packages = array from dbService.getPackagesByCountry()
 */
const sendPackageEmail = async ({ to, customerName, packages, agentId }) => {
  const packageRows = packages
    .map((pkg) => {
      const dates = pkg.availableDates.slice(0, 5).map((d) => d.date).join(', ');
      const firstDate = pkg.availableDates[0];
      return `
        <tr>
          <td style="padding:10px;border-bottom:1px solid #eee;">
            <strong>${pkg.title}</strong><br/>
            <span style="color:#666;">Duration: ${pkg.durationDays} Days</span>
          </td>
          <td style="padding:10px;border-bottom:1px solid #eee;color:#555;">
            ${dates}
          </td>
          <td style="padding:10px;border-bottom:1px solid #eee;text-align:center;">
            <a href="${firstDate?.pdfUrl || '#'}" style="color:#4f46e5;margin-right:8px;">📄 PDF</a>
            <a href="${firstDate?.bookingLink || '#'}" style="color:#22c55e;">🔗 Book</a>
          </td>
        </tr>`;
    })
    .join('');

  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:640px;margin:auto;">
      <div style="background:#0f172a;padding:24px;border-radius:8px 8px 0 0;">
        <h1 style="color:#fff;margin:0;font-size:20px;">Culture Holidays</h1>
        <p style="color:rgba(255,255,255,0.6);margin:4px 0 0;">Your personalised tour packages</p>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #e2e8f0;border-top:none;">
        <p>Dear ${customerName || 'Traveller'},</p>
        <p>Thank you for your enquiry. Here are the tour packages we recommend for you:</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:16px 0;">
          <thead>
            <tr style="background:#f8fafc;">
              <th style="padding:10px;text-align:left;font-size:12px;color:#64748b;text-transform:uppercase;">Package</th>
              <th style="padding:10px;text-align:left;font-size:12px;color:#64748b;text-transform:uppercase;">Available Dates</th>
              <th style="padding:10px;text-align:center;font-size:12px;color:#64748b;text-transform:uppercase;">Links</th>
            </tr>
          </thead>
          <tbody>${packageRows}</tbody>
        </table>
        <p style="color:#64748b;font-size:13px;">
          Click the <strong>PDF</strong> link to view the full itinerary and the <strong>Book</strong> link to complete your booking.
        </p>
        ${agentId ? `<p style="color:#64748b;font-size:13px;">Your Agent ID: <strong>${agentId}</strong></p>` : ''}
        <p>Need help? Call us at <strong>+91-XXXXXXXXXX</strong> or reply to this email.</p>
      </div>
      <div style="background:#f8fafc;padding:16px;text-align:center;font-size:12px;color:#94a3b8;border-radius:0 0 8px 8px;">
        © Culture Holidays. All rights reserved.
      </div>
    </div>`;

  const info = await getTransporter().sendMail({
    from: config.EMAIL_FROM,
    to,
    subject: `Your Tour Package Details — Culture Holidays`,
    html,
  });

  logger.info(`Email sent to ${to}: ${info.messageId}`);
  return info;
};

const sendBookingLinkEmail = async ({ to, customerName, bookingUrl }) => {
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:640px;margin:auto;">
      <div style="background:#0f172a;padding:24px;border-radius:8px 8px 0 0;">
        <h1 style="color:#fff;margin:0;font-size:20px;">Culture Holidays</h1>
        <p style="color:rgba(255,255,255,0.6);margin:4px 0 0;">Your booking link</p>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #e2e8f0;border-top:none;">
        <p>Dear ${customerName || 'Traveller'},</p>
        <p>Please use the link below to complete your booking:</p>
        <p style="text-align:center;margin:24px 0;">
          <a href="${bookingUrl}" style="background:#22c55e;color:#fff;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:16px;">
            Complete Your Booking
          </a>
        </p>
        <p style="color:#64748b;font-size:13px;">Or copy this link: <a href="${bookingUrl}">${bookingUrl}</a></p>
        <p>Need help? Call us or reply to this email.</p>
      </div>
      <div style="background:#f8fafc;padding:16px;text-align:center;font-size:12px;color:#94a3b8;border-radius:0 0 8px 8px;">
        © Culture Holidays. All rights reserved.
      </div>
    </div>`;

  const info = await getTransporter().sendMail({
    from: config.EMAIL_FROM,
    to,
    subject: 'Your Booking Link — Culture Holidays',
    html,
  });
  logger.info(`Booking link email sent to ${to}: ${info.messageId}`);
  return info;
};

const sendPaymentLinkEmail = async ({ to, customerName, paymentUrl, amount }) => {
  const amountLine = amount ? `<p style="font-size:18px;font-weight:600;color:#0f172a;">Amount Due: ${amount}</p>` : '';
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:640px;margin:auto;">
      <div style="background:#0f172a;padding:24px;border-radius:8px 8px 0 0;">
        <h1 style="color:#fff;margin:0;font-size:20px;">Culture Holidays</h1>
        <p style="color:rgba(255,255,255,0.6);margin:4px 0 0;">Payment details</p>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #e2e8f0;border-top:none;">
        <p>Dear ${customerName || 'Traveller'},</p>
        <p>Please use the secure link below to complete your payment:</p>
        ${amountLine}
        <p style="text-align:center;margin:24px 0;">
          <a href="${paymentUrl}" style="background:#4f46e5;color:#fff;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:16px;">
            Pay Now
          </a>
        </p>
        <p style="color:#64748b;font-size:13px;">Or copy this link: <a href="${paymentUrl}">${paymentUrl}</a></p>
        <p style="color:#94a3b8;font-size:12px;">This link is unique to your booking. Do not share it with others.</p>
      </div>
      <div style="background:#f8fafc;padding:16px;text-align:center;font-size:12px;color:#94a3b8;border-radius:0 0 8px 8px;">
        © Culture Holidays. All rights reserved.
      </div>
    </div>`;

  const info = await getTransporter().sendMail({
    from: config.EMAIL_FROM,
    to,
    subject: 'Payment Link — Culture Holidays',
    html,
  });
  logger.info(`Payment link email sent to ${to}: ${info.messageId}`);
  return info;
};

const sendRegistrationLinkEmail = async ({ to, registrationUrl }) => {
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:640px;margin:auto;">
      <div style="background:#0f172a;padding:24px;border-radius:8px 8px 0 0;">
        <h1 style="color:#fff;margin:0;font-size:20px;">Culture Holidays</h1>
        <p style="color:rgba(255,255,255,0.6);margin:4px 0 0;">Agent registration</p>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #e2e8f0;border-top:none;">
        <p>Hi there,</p>
        <p>You're one step away from joining the Culture Holidays agent network. Click below to complete your registration:</p>
        <p style="text-align:center;margin:24px 0;">
          <a href="${registrationUrl}" style="background:#0f172a;color:#fff;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:16px;">
            Register as Agent
          </a>
        </p>
        <p style="color:#64748b;font-size:13px;">Or copy this link: <a href="${registrationUrl}">${registrationUrl}</a></p>
        <p>Once registered, you'll be able to access exclusive packages, your booking history, and priority support.</p>
      </div>
      <div style="background:#f8fafc;padding:16px;text-align:center;font-size:12px;color:#94a3b8;border-radius:0 0 8px 8px;">
        © Culture Holidays. All rights reserved.
      </div>
    </div>`;

  const info = await getTransporter().sendMail({
    from: config.EMAIL_FROM,
    to,
    subject: 'Join Culture Holidays — Agent Registration',
    html,
  });
  logger.info(`Registration link email sent to ${to}: ${info.messageId}`);
  return info;
};

const sendGenericEmail = async ({ to, subject, html, text }) => {
  const info = await getTransporter().sendMail({
    from: config.EMAIL_FROM,
    to,
    subject,
    html,
    text,
  });
  logger.info(`Email sent to ${to}: ${info.messageId}`);
  return info;
};

module.exports = { sendPackageEmail, sendBookingLinkEmail, sendPaymentLinkEmail, sendRegistrationLinkEmail, sendGenericEmail };
