import { decideCspAlert } from '../../alerts/decide.js';
import { recordCspEvent } from '../../store/origins.js';
import { toCspEvent, type CspEvent } from '../csp.js';
import { classifyNoise } from '../noise.js';
import type { ReportHandler } from './types.js';

export const cspHandler: ReportHandler<CspEvent> = {
  type: 'csp-violation',
  toEvent: (raw, site) => toCspEvent(raw, site.domains, raw.userAgent),
  keys: e => [e.directive, e.origin],
  noise: (e, site, extra) => classifyNoise(e, site.domains, extra),
  record: (ctx, e, raw) => recordCspEvent(ctx.db, ctx.site, e, ctx.now, raw.body),
  decide: (ctx, e, r) =>
    decideCspAlert({ site: ctx.site, event: e, noise: null, result: r, now: ctx.now })
      ? { kind: 'new-origin', originId: r.originId }
      : null,
};
