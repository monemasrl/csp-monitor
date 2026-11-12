import { hostMatchesDomains, matchesPattern } from '../match.js';
import { EXTENSION_SCHEMES, type CspEvent } from './csp.js';

export type NoiseReason = 'extension' | 'foreign-document' | 'known-noise' | 'bot';

/**
 * Origins injected into pages by client-side software (antivirus, translators,
 * browser add-ons), not by the site itself. Kept deliberately short: only
 * entries whose origin is well known.
 */
export const BUILTIN_NOISE: string[] = [
  // Kaspersky web protection injects scripts from its own domains into visited pages.
  '*.kaspersky-labs.com',
  'gc.kis.v2.scr.kaspersky-labs.com',
  // Google Translate: translated pages are served from *.translate.goog, scripts from translate.googleapis.com.
  '*.translate.goog',
  'translate.googleapis.com',
  // Grammarly browser extension talks to its own backend from inside the page.
  '*.grammarly.io',
  // LastPass browser extension.
  '*.lastpass.com',
];

const hasExtensionScheme = (s: string): boolean => {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s.trim())?.[1]?.toLowerCase();
  return scheme !== undefined && EXTENSION_SCHEMES.includes(scheme);
};

export type NoiseInput = Pick<CspEvent, 'blockedRaw' | 'sourceFile' | 'documentHost' | 'isBot' | 'origin'>;

/** Order matters: extension, foreign-document, bot, known-noise. */
export function classifyNoise(e: NoiseInput, siteDomains: string[], extraPatterns: string[]): NoiseReason | null {
  if (hasExtensionScheme(e.blockedRaw) || hasExtensionScheme(e.sourceFile)) return 'extension';
  if (!hostMatchesDomains(e.documentHost, siteDomains)) return 'foreign-document';
  if (e.isBot) return 'bot';
  // matchesPattern only matches real URL origins, so inline/eval/data never count as known noise.
  if ([...BUILTIN_NOISE, ...extraPatterns].some(p => matchesPattern(p, e.origin))) return 'known-noise';
  return null;
}
