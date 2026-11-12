/** Every kind of alert the system can raise (labels and rendering come with the handlers that use them). */
export type AlertKind =
  | 'new-origin' | 'integrity' | 'new-connection' | 'permission' | 'coop-blocked' | 'coep-blocked'
  | 'hash-changed' | 'new-script' | 'nel-rate' | 'tls-error' | 'crash-spike' | 'deprecation' | 'deprecation-reminder';
