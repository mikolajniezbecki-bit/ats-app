// Email transport (tech-stack.md §9, ats-project-scope.md E6, C4): the only
// code that imports Nodemailer (§3 rule 4, ESLint). It builds and hands over
// a finished message and holds no business rules. Both providers build the
// message the same way; `smtp` hands it to Mailpit (local/CI), `outbox`
// builds it without sending, so nothing ever leaves the system in Azure.
import nodemailer from "nodemailer";
import { getConfig } from "../../config";

export type EmailProvider = "smtp" | "outbox";

export type OutgoingAttachment = { filename: string; content: Buffer; contentType: string };

export type OutgoingEmail = {
  messageId: string;
  from: string;
  replyTo: string;
  to: string;
  cc: string[];
  subject: string;
  html: string;
  text: string;
  /** The `.ics` invite, sent as a text/calendar alternative and as `invite.ics` (I2). */
  calendar?: { method: "REQUEST" | "CANCEL"; content: string };
  attachments: OutgoingAttachment[];
};

export interface EmailTransport {
  readonly provider: EmailProvider;
  /** Hands the message over; resolves when the transport accepted it. */
  send(email: OutgoingEmail): Promise<void>;
}

type NodemailerTransport = ReturnType<typeof nodemailer.createTransport>;

function toNodemailer(email: OutgoingEmail) {
  return {
    messageId: email.messageId,
    from: email.from,
    replyTo: email.replyTo,
    to: email.to,
    cc: email.cc.length > 0 ? email.cc : undefined,
    subject: email.subject,
    html: email.html,
    text: email.text,
    icalEvent: email.calendar ? { method: email.calendar.method, filename: "invite.ics", content: email.calendar.content } : undefined,
    attachments: email.attachments.map((attachment) => ({ ...attachment })),
  };
}

function nodemailerTransport(provider: EmailProvider, transport: NodemailerTransport): EmailTransport {
  return {
    provider,
    async send(email) {
      await transport.sendMail(toNodemailer(email));
    },
  };
}

/** SMTP without authentication (Mailpit). */
export function smtpTransport(host: string, port: number): EmailTransport {
  return nodemailerTransport("smtp", nodemailer.createTransport({ host, port, secure: false, ignoreTLS: true }));
}

/** Builds the full message like SMTP would, then keeps it: nothing is delivered (E6). */
export function outboxTransport(): EmailTransport {
  return nodemailerTransport("outbox", nodemailer.createTransport({ streamTransport: true, buffer: true }));
}

let instance: EmailTransport | undefined;

/** The configured transport, created on first use (never at import time, W1). */
export function getEmailTransport(): EmailTransport {
  if (!instance) {
    const email = getConfig().email;
    instance = email.provider === "smtp" ? smtpTransport(email.host, email.port) : outboxTransport();
  }
  return instance;
}
