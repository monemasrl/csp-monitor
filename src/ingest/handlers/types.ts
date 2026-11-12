import type { AlertKind } from '../../alerts/kinds.js';
import type { Db } from '../../db/db.js';
import type { RecordResult } from '../../store/origins.js';
import type { Site } from '../../store/sites.js';
import type { NoiseReason } from '../noise.js';
import type { RawReport } from '../parse.js';

export type HandlerContext = { db: Db; site: Site; now: number };

export type AlertRequest = {
  kind: AlertKind;
  originId?: number;
  payload?: Record<string, unknown>;
  immediate?: boolean;
};

/** Per-type behaviour: parse, filter noise, store, decide whether to alert. */
export interface ReportHandler<E> {
  type: string;
  toEvent(raw: RawReport, site: Site): E | null;
  /** The (keyA, keyB) pair that identifies the event for the rate-limit KnownCache. */
  keys(e: E): [string, string];
  noise(e: E, site: Site, extra: string[]): NoiseReason | null;
  /** Null when the report was only counted and nothing was stored (e.g. NEL 'ok'): the pipeline then skips `decide`. */
  record(ctx: HandlerContext, e: E, raw: RawReport): RecordResult | null;
  decide(ctx: HandlerContext, e: E, r: RecordResult): AlertRequest | null;
}
