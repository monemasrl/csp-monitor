import { cspHandler } from './csp.js';
import type { ReportHandler } from './types.js';

/** Report type -> handler. A type without an entry is stored in `discarded` as unsupported. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const HANDLERS = new Map<string, ReportHandler<any>>([[cspHandler.type, cspHandler]]);
