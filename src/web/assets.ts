import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Same relative path works from src/web (tsx) and dist/web (built).
export const STYLE_CSS = readFileSync(new URL('../../src/web/static/style.css', import.meta.url), 'utf8');

/** Versioned URL: a new deploy with different CSS gets a new URL, so the 1h browser cache never serves stale styles. */
export const STYLE_HREF = `/static/style.css?v=${createHash('sha256').update(STYLE_CSS).digest('hex').slice(0, 10)}`;
