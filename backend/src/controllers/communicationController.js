const dbService = require('../services/dbService');
const emailService = require('../services/emailService');
const smsService = require('../services/smsService');
const logger = require('../utils/logger');

class CommunicationController {
  /**
   * POST /api/communication/send-packages
   * Sends package details via email and/or SMS, then logs both.
   *
   * Body: { phone, email, customerName, packages, agentId, callLogId, channels: ['email','sms'] }
   */
  async sendPackages(req, res) {
    const { phone, email, customerName, packages, agentId, callLogId, channels = ['email', 'sms'] } = req.body;

    if (!packages || packages.length === 0) {
      return res.status(400).json({ success: false, error: 'packages array is required' });
    }

    const results = { email: null, sms: null };
    const errors = [];

    // ── Email ──────────────────────────────────────────────────
    if (channels.includes('email') && email) {
      try {
        const info = await emailService.sendPackageEmail({ to: email, customerName, packages, agentId });
        results.email = { sent: true, messageId: info.messageId };

        await dbService.insertCommunicationLog({
          channel: 'email',
          recipient_email: email,
          call_log_id: callLogId || null,
          subject: 'Your Tour Package Details — Culture Holidays',
          body: `Packages sent: ${packages.map((p) => p.title).join(', ')}`,
          status: 'sent',
        });
      } catch (err) {
        logger.error('Email send failed', { err: err.message });
        errors.push(`Email: ${err.message}`);
        results.email = { sent: false, error: err.message };
      }
    }

    // ── SMS ────────────────────────────────────────────────────
    if (channels.includes('sms') && phone) {
      try {
        const msg = await smsService.sendPackageSMS({ to: phone, customerName, packages });
        results.sms = { sent: true, sid: msg.sid };

        await dbService.insertCommunicationLog({
          channel: 'sms',
          recipient_phone: phone,
          call_log_id: callLogId || null,
          twilio_msg_sid: msg.sid,
          body: `Package SMS sent to ${phone}`,
          status: 'sent',
        });
      } catch (err) {
        logger.error('SMS send failed', { err: err.message });
        errors.push(`SMS: ${err.message}`);
        results.sms = { sent: false, error: err.message };
      }
    }

    const anySent = results.email?.sent || results.sms?.sent;
    res.json({
      success: anySent,
      results,
      errors: errors.length ? errors : undefined,
      message: anySent
        ? 'Package details sent successfully.'
        : 'Failed to send package details.',
    });
  }

  /**
   * POST /api/communication/schedule-callback
   * Body: { phone, reason, department, callLogId, priority }
   */
  async scheduleCallback(req, res) {
    const { phone, reason, department, callLogId, priority } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'phone is required' });

    const result = await dbService.scheduleCallback({
      phone,
      call_log_id: callLogId || null,
      reason,
      department: department || 'sales',
      priority: priority || 1,
    });

    res.json({ success: true, callbackId: result?.id, message: 'Callback scheduled successfully.' });
  }

  /** GET /api/communication/callbacks */
  async getPendingCallbacks(req, res) {
    const callbacks = await dbService.getPendingCallbacks();
    res.json({ success: true, count: callbacks.length, callbacks });
  }

  /** PUT /api/communication/callbacks/:id/status */
  async updateCallbackStatus(req, res) {
    const { status } = req.body;
    await dbService.updateCallbackStatus(req.params.id, status);
    res.json({ success: true, message: 'Callback status updated.' });
  }
}

module.exports = new CommunicationController();
