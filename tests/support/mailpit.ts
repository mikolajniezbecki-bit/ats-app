// Reads real messages from Mailpit's API (tech-stack.md §9, §11). Tests run
// in parallel against one Mailpit, so there is deliberately no "delete all":
// each test sends to its own e2e-<uuid>@example.com recipients and searches
// for them.

export const MAILPIT_URL = (process.env.E2E_MAILPIT_URL ?? "http://localhost:8025").replace(/\/+$/, "");

type Address = { Name: string; Address: string };
type Summary = { ID: string; Subject: string; To: Address[] };
type Part = { PartID: string; FileName: string; ContentType: string };

export type MailpitAttachment = { name: string; contentType: string; bytes: Buffer };
export type MailpitMessage = {
  id: string;
  messageId: string;
  from: string;
  to: string[];
  cc: string[];
  replyTo: string[];
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string[]>;
  attachments: MailpitAttachment[];
  /** The raw MIME source, e.g. to check the text/calendar alternative. */
  raw: string;
};

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`${MAILPIT_URL}${path}`);
  if (!response.ok) throw new Error(`Mailpit ${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** Messages to `to`, newest first. */
export async function searchMessages(to: string): Promise<Summary[]> {
  const result = await api<{ messages: Summary[] }>(`/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  return result.messages;
}

/** Waits until a message to `to` (with `subjectIncludes`) arrives and returns it. */
export async function waitForMessage({
  to,
  subjectIncludes,
  timeoutMs = 5_000,
}: {
  to: string;
  subjectIncludes?: string;
  timeoutMs?: number;
}): Promise<MailpitMessage> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = (await searchMessages(to)).find((message) => !subjectIncludes || message.Subject.includes(subjectIncludes));
    if (match) return getMessage(match.ID);
    if (Date.now() > deadline) throw new Error(`No Mailpit message to ${to} within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** One message with headers, bodies and attachment bytes. */
export async function getMessage(id: string): Promise<MailpitMessage> {
  const message = await api<{
    ID: string;
    MessageID: string;
    From: Address;
    To: Address[];
    Cc: Address[] | null;
    ReplyTo: Address[] | null;
    Subject: string;
    HTML: string;
    Text: string;
    Attachments: Part[];
    Inline: Part[];
  }>(`/api/v1/message/${id}`);
  const headers = await api<Record<string, string[]>>(`/api/v1/message/${id}/headers`);
  const attachments = await Promise.all(
    [...message.Attachments, ...message.Inline].map(async (part) => {
      const response = await fetch(`${MAILPIT_URL}/api/v1/message/${id}/part/${part.PartID}`);
      return { name: part.FileName, contentType: part.ContentType, bytes: Buffer.from(await response.arrayBuffer()) };
    }),
  );
  const raw = await (await fetch(`${MAILPIT_URL}/api/v1/message/${id}/raw`)).text();
  const addresses = (list: Address[] | null) => (list ?? []).map((entry) => entry.Address);
  return {
    id: message.ID,
    messageId: message.MessageID,
    from: message.From.Address,
    to: addresses(message.To),
    cc: addresses(message.Cc),
    replyTo: addresses(message.ReplyTo),
    subject: message.Subject,
    html: message.HTML,
    text: message.Text,
    headers,
    attachments,
    raw,
  };
}
