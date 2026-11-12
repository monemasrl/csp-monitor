import { cspHandler } from './csp.js';
import { deprecationHandler } from './deprecation.js';
import { hashHandler } from './hash.js';
import { crashHandler, networkErrorHandler } from './rates.js';
import {
  coepHandler, connectionHandler, coopHandler, documentPolicyHandler, integrityHandler,
  interventionHandler, permissionsHandler,
} from './simple.js';
import type { ReportHandler } from './types.js';

/** Report type -> handler. A type without an entry is stored in `discarded` as unsupported. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const HANDLERS = new Map<string, ReportHandler<any>>(
  [cspHandler, integrityHandler, connectionHandler, permissionsHandler, documentPolicyHandler, interventionHandler, coopHandler, coepHandler, hashHandler, deprecationHandler, networkErrorHandler, crashHandler]
    .map(h => [h.type, h]),
);
