import nodemailer from 'nodemailer';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { getSetting } from '../store/settings.js';

export type AlertMessage = { subject: string; text: string; html: string };

/** Delivery channel for alerts. send() must reject on failure so the alerts stay queued. */
export interface AlertChannel {
  name: string;
  send(msg: AlertMessage): Promise<void>;
}

type SmtpConfig = Config['smtp'];

export class EmailChannel implements AlertChannel {
  readonly name = 'email';
  private readonly transport: nodemailer.Transporter;

  /** `transportOverride` replaces the SMTP options (tests use `{ jsonTransport: true }`). */
  constructor(
    private readonly smtp: SmtpConfig,
    private readonly recipient: () => string,
    transportOverride?: Record<string, unknown>,
  ) {
    this.transport = nodemailer.createTransport(
      (transportOverride ?? {
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      }) as nodemailer.TransportOptions,
    );
  }

  static fromConfig(db: Db, config: Config, transportOverride?: Record<string, unknown>): EmailChannel {
    return new EmailChannel(config.smtp, () => getSetting(db, 'alert_email') ?? config.alertEmail, transportOverride);
  }

  sendRaw(msg: AlertMessage): Promise<{ message?: unknown }> {
    return this.transport.sendMail({
      from: this.smtp.from, to: this.recipient(), subject: msg.subject, text: msg.text, html: msg.html,
    }) as Promise<{ message?: unknown }>;
  }

  async send(msg: AlertMessage): Promise<void> {
    await this.sendRaw(msg);
  }
}
