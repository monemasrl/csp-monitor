import type { AlertItemAny } from './queue.js';

/** Every kind of alert the system can raise. */
export type AlertKind =
  | 'new-origin' | 'integrity' | 'new-connection' | 'permission' | 'coop-blocked' | 'coep-blocked'
  | 'hash-changed' | 'new-script' | 'nel-rate' | 'tls-error' | 'crash-spike' | 'deprecation' | 'deprecation-reminder';

/** Origin-based items describe the origin/directive, payload-only items list their payload fields. */
function generic(i: AlertItemAny): string {
  if (i.originId) return i.directive ? `${i.origin} (${i.directive})` : i.origin;
  return Object.entries(i.payload ?? {}).map(([k, v]) => `${k}: ${String(v)}`).join(', ');
}

export const ALERT_KINDS: Record<AlertKind, { label: string; describe(item: AlertItemAny): string }> = {
  'new-origin': { label: 'Nuova origine', describe: generic },
  'hash-changed': { label: 'Script modificato', describe: generic },
  'integrity': { label: 'Risorsa senza integrità valida', describe: generic },
  'new-connection': { label: 'Connessione non dichiarata', describe: generic },
  'permission': { label: 'Funzione sensibile richiesta', describe: generic },
  'coop-blocked': { label: 'Interazione tra finestre bloccata (COOP)', describe: generic },
  'coep-blocked': { label: 'Risorsa bloccata (COEP)', describe: generic },
  'new-script': { label: 'Nuovo script', describe: generic },
  'nel-rate': { label: 'Errori di rete oltre soglia', describe: generic },
  'tls-error': { label: 'Errore di certificato TLS', describe: generic },
  'crash-spike': { label: 'Crash in aumento', describe: generic },
  'deprecation': { label: 'API deprecata', describe: generic },
  'deprecation-reminder': { label: 'Promemoria rimozione API', describe: generic },
};
