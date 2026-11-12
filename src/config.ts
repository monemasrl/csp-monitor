export type Config = {
  port: number;
  baseUrl: string;
  dataDir: string;
  adminPasswordHash: string;
  sessionSecret: string;
  trustProxy: boolean;
  secureCookies: boolean;
  smtp: { host: string; port: number; user?: string; pass?: string; from: string; secure: boolean };
  alertEmail: string;
  logRequests: boolean;
};

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name];
  if (v === undefined || v === '') throw new Error(`Missing required environment variable ${name}`);
  return v;
}

function flag(env: Env, name: string, def: boolean): boolean {
  const v = env[name];
  if (v === undefined || v === '') return def;
  return v === '1' || v.toLowerCase() === 'true';
}

function int(env: Env, name: string, def: number): number {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid environment variable ${name}: ${v}`);
  return n;
}

export function loadConfig(env: Env): Config {
  const baseUrl = required(env, 'BASE_URL');
  const adminPasswordHash = required(env, 'ADMIN_PASSWORD_HASH');
  const sessionSecret = required(env, 'SESSION_SECRET');
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  return {
    port: int(env, 'PORT', 3000),
    baseUrl,
    dataDir: env.DATA_DIR || '/data',
    adminPasswordHash,
    sessionSecret,
    trustProxy: flag(env, 'TRUST_PROXY', true),
    secureCookies: flag(env, 'SECURE_COOKIES', true),
    smtp: {
      host: required(env, 'SMTP_HOST'),
      port: int(env, 'SMTP_PORT', 587),
      user: env.SMTP_USER || undefined,
      pass: env.SMTP_PASS || undefined,
      from: required(env, 'SMTP_FROM'),
      secure: flag(env, 'SMTP_SECURE', false),
    },
    alertEmail: required(env, 'ALERT_EMAIL'),
    logRequests: flag(env, 'LOG_REQUESTS', true),
  };
}
