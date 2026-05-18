'use strict';

// In-memory OTP store — keyed by phone number (E.164).
// Entries expire after 5 minutes.
// Server enforces a maximum of 3 wrong-attempt tries per OTP.

const store = new Map();
const MAX_ATTEMPTS = 3;

const generate = () => Math.floor(1000 + Math.random() * 9000).toString();

const create = (phone) => {
  const otp = generate();
  store.set(phone, { otp, expiry: Date.now() + 5 * 60 * 1000, attempts: 0 });
  return otp;
};

const verify = (phone, input) => {
  const entry = store.get(phone);
  if (!entry) return { valid: false, reason: 'no_otp' };

  if (Date.now() > entry.expiry) {
    store.delete(phone);
    return { valid: false, reason: 'expired' };
  }

  entry.attempts += 1;

  if (entry.attempts > MAX_ATTEMPTS) {
    store.delete(phone);
    return { valid: false, reason: 'too_many_attempts' };
  }

  if (entry.otp !== String(input).trim()) {
    return { valid: false, reason: 'wrong_otp', attemptsLeft: MAX_ATTEMPTS - entry.attempts };
  }

  store.delete(phone);
  return { valid: true };
};

const mask = (phone) => {
  if (!phone || phone.length < 4) return phone;
  return phone.slice(0, -4).replace(/\d/g, '*') + phone.slice(-4);
};

// Explicit removal — call when caller gives up or call ends
const remove = (phone) => store.delete(phone);

module.exports = { create, verify, mask, remove };
