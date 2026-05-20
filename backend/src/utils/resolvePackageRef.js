'use strict';

const logger = require('./logger');

/**
 * Fast backend resolution: position words + name fragment only.
 * No external LLM call — if these don't match, returns null and
 * the caller should fall back to asking the Vapi LLM to resolve.
 */
function resolvePackageRef(userText, packages) {
  if (!userText || !packages?.length) return null;

  const lower = userText.toLowerCase();

  // Position words
  if (/\b(first|1st|one|option\s*1|number\s*1)\b/.test(lower)) {
    logger.info(`  resolvePackageRef: position "first" → pkgId=${packages[0]?.pkgId}`);
    return packages[0]?.pkgId ?? null;
  }
  if (/\b(second|2nd|two|option\s*2|number\s*2)\b/.test(lower)) {
    logger.info(`  resolvePackageRef: position "second" → pkgId=${packages[1]?.pkgId}`);
    return packages[1]?.pkgId ?? null;
  }
  if (/\b(third|3rd|three|last|option\s*3|number\s*3)\b/.test(lower)) {
    logger.info(`  resolvePackageRef: position "third/last" → pkgId=${packages[packages.length - 1]?.pkgId}`);
    return packages[packages.length - 1]?.pkgId ?? null;
  }

  // Name fragment — any word > 3 chars found in a package title
  const words = lower.split(/\s+/).filter(w => w.length > 3);
  for (const pkg of packages) {
    const title = (pkg.title || '').toLowerCase();
    if (words.some(w => title.includes(w))) {
      logger.info(`  resolvePackageRef: name-match "${pkg.title}" for "${userText}"`);
      return pkg.pkgId;
    }
  }

  return null; // let Vapi LLM handle it
}

module.exports = resolvePackageRef;
