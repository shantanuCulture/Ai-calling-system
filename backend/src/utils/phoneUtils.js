'use strict';

/**
 * Normalises a phone string to E.164 format (+<digits>).
 *
 * Twilio always delivers E.164 in webhooks (+91XXXXXXXXXX).
 * tbl_agent.Contact may store numbers without the leading '+'.
 * This function handles the gap so lookups match consistently.
 *
 * Examples:
 *   "+919876543210"     → "+919876543210"   (already E.164)
 *   "919876543210"      → "+919876543210"   (missing +, 12 digits)
 *   "+1 (555) 000-1234" → "+15550001234"    (spaces/parens stripped)
 *   "anonymous"         → null              (not a number)
 */
const normalize = (phone) => {
  if (!phone || typeof phone !== 'string') return null;
  const stripped = phone.replace(/[\s\-().]/g, '');
  if (!stripped || /[^+\d]/.test(stripped)) return null;
  if (stripped.startsWith('+')) return stripped;
  if (/^\d{11,15}$/.test(stripped)) return '+' + stripped;
  return stripped;
};

/**
 * Returns true when two phone strings resolve to the same E.164 number.
 */
const isSame = (a, b) => {
  const na = normalize(a);
  const nb = normalize(b);
  return Boolean(na && nb && na === nb);
};

module.exports = { normalize, isSame };
