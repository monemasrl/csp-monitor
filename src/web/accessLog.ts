import type { MiddlewareHandler } from 'hono';

/** Control characters and whitespace become '_'; capped at 200 chars (log-injection safe). */
export function sanitizePath(p: string): string {
  return p.replace(/[\s\x00-\x1f\x7f-\x9f]/g, '_').slice(0, 200);
}

/** One line per request: method, pathname only (no query), status, duration. /health is logged only when not 200. */
export function accessLog(write: (line: string) => void = (l) => console.log(l)): MiddlewareHandler {
  return async (c, next) => {
    const t0 = performance.now();
    await next();
    try {
      const status = c.res.status;
      const path = c.req.path;
      if (path === '/health' && status === 200) return;
      write(`[http] ${sanitizePath(c.req.method)} ${sanitizePath(path)} ${status} ${Math.round(performance.now() - t0)}ms`);
    } catch { /* logging must never affect the response */ }
  };
}
