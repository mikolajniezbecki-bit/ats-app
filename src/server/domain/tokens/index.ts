// Template tokens (ats-project-scope.md §5.1 Tokens; tech-stack.md P2, P5).
// Pure: no framework imports. `[[NAME]]` placeholders are replaced in one
// pass; anything else in `[[…]]` is an error, never output as raw text.
// Errors name the token only, never a value (M2).

/** The 13 §5.1 tokens. */
export const TOKENS = [
  "CANDIDATE_FULL_NAME",
  "JOB_TITLE",
  "REQ_NUMBER",
  "HIRING_MGR_FULL_NAME",
  "RECRUITER_FULL_NAME",
  "RECRUITER_EMAIL",
  "INTERVIEW_DATETIME",
  "INTERVIEW_LOCATION",
  "OFFER_SALARY",
  "OFFER_CURRENCY",
  "START_DATE",
  "LEGAL_ENTITY",
  "LOGO",
] as const;

export type Token = (typeof TOKENS)[number];
export type TokenValues = Partial<Record<Token, string | null | undefined>>;
export type OutputMode = "html" | "text" | "subject";

const TOKEN_SET: ReadonlySet<string> = new Set(TOKENS);

export function isToken(name: string): name is Token {
  return TOKEN_SET.has(name);
}

/** Where each template part may use which tokens (§5.1 "Scopes"). */
const SUBJECT_TOKENS: readonly Token[] = [
  "CANDIDATE_FULL_NAME",
  "JOB_TITLE",
  "REQ_NUMBER",
  "HIRING_MGR_FULL_NAME",
  "RECRUITER_FULL_NAME",
  "RECRUITER_EMAIL",
  "LEGAL_ENTITY",
];
const EMAIL_BODY_TOKENS: readonly Token[] = [...SUBJECT_TOKENS, "LOGO"];
const OFFER_BODY_TOKENS: readonly Token[] = [...EMAIL_BODY_TOKENS, "OFFER_SALARY", "OFFER_CURRENCY", "START_DATE"];

export const TOKEN_SCOPES = {
  emailSubject: SUBJECT_TOKENS,
  emailBody: EMAIL_BODY_TOKENS,
  offerBody: OFFER_BODY_TOKENS,
} as const;

export type TokenScope = keyof typeof TOKEN_SCOPES;

export class UnknownTokenError extends Error {
  override name = "UnknownTokenError";
  constructor(readonly token: string) {
    super(`Unknown token [[${token}]]`);
  }
}

export class UnclosedTokenError extends Error {
  override name = "UnclosedTokenError";
  constructor() {
    super("Unclosed [[ in template");
  }
}

export class MissingTokenValueError extends Error {
  override name = "MissingTokenValueError";
  constructor(readonly token: Token) {
    super(`No value for token [[${token}]]`);
  }
}

export class TokenNotAllowedError extends Error {
  override name = "TokenNotAllowedError";
  constructor(readonly token: Token) {
    super(`Token [[${token}]] is not allowed here`);
  }
}

type Part = { kind: "text"; text: string } | { kind: "token"; token: Token };

/**
 * Splits `text` into literal text and tokens. Throws UnknownTokenError for a
 * `[[…]]` that isn't exactly a catalogue name, and UnclosedTokenError for a
 * `[[` without `]]`.
 */
export function parseTokens(text: string): Part[] {
  const parts: Part[] = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("[[", index);
    if (open === -1) {
      parts.push({ kind: "text", text: text.slice(index) });
      break;
    }
    if (open > index) parts.push({ kind: "text", text: text.slice(index, open) });
    const close = text.indexOf("]]", open + 2);
    if (close === -1) throw new UnclosedTokenError();
    const name = text.slice(open + 2, close);
    if (!isToken(name)) throw new UnknownTokenError(name);
    parts.push({ kind: "token", token: name });
    index = close + 2;
  }
  return parts;
}

/** The tokens used in `text`, in order of first use. */
export function tokensIn(text: string): Token[] {
  return [...new Set(parseTokens(text).flatMap((part) => (part.kind === "token" ? [part.token] : [])))];
}

/** Checks a template part on save: every token known and allowed in `scope`. */
export function checkTokens(text: string, scope: TokenScope): void {
  const allowed: readonly Token[] = TOKEN_SCOPES[scope];
  for (const token of tokensIn(text)) if (!allowed.includes(token)) throw new TokenNotAllowedError(token);
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function render(token: Token, value: string, mode: OutputMode): string {
  if (token === "LOGO") {
    if (mode === "subject") throw new TokenNotAllowedError(token);
    // The value is the logo's data: URI (P5); text bodies have no image.
    return mode === "html" ? `<img src="${escapeHtml(value)}" alt="Logo">` : "";
  }
  if (mode === "html") return escapeHtml(value);
  // A subject is one header line: a value can't add another (header injection).
  if (mode === "subject") return value.replace(/[\r\n]+/g, " ");
  return value;
}

/**
 * Replaces every token in `text` in one pass: values are escaped for `html`,
 * inserted as-is for `text`, and kept on one line for `subject`. A value that
 * itself contains `[[…]]` is output literally, never resolved again.
 */
export function resolveTokens(text: string, values: TokenValues, mode: OutputMode): string {
  return parseTokens(text)
    .map((part) => {
      if (part.kind === "text") return part.text;
      const value = values[part.token];
      if (value === undefined || value === null) throw new MissingTokenValueError(part.token);
      return render(part.token, value, mode);
    })
    .join("");
}
