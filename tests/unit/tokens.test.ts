// Token resolution (ats-project-scope.md §5.1 Tokens; tech-stack.md P5):
// catalogue, syntax, escaping per output, scopes and value formats.
import { describe, expect, it } from "vitest";
import {
  MissingTokenValueError,
  TOKENS,
  TOKEN_SCOPES,
  TokenNotAllowedError,
  type TokenValues,
  UnclosedTokenError,
  UnknownTokenError,
  checkTokens,
  resolveTokens,
} from "@/server/domain/tokens";
import { formatAmount, formatDate, formatInterviewDateTime } from "@/server/domain/tokens/format";

const LOGO = "data:image/png;base64,iVBORw0KGgo=";

const VALUES: Required<Record<(typeof TOKENS)[number], string>> = {
  CANDIDATE_FULL_NAME: "Ada Lovelace",
  JOB_TITLE: "Backend Engineer",
  REQ_NUMBER: "REQ-00042",
  HIRING_MGR_FULL_NAME: "Grace Hopper",
  RECRUITER_FULL_NAME: "Rita Recruiter",
  RECRUITER_EMAIL: "rita@ats-demo.local",
  INTERVIEW_DATETIME: "Monday, 15 January 2027, 14:00 (Europe/Warsaw)",
  INTERVIEW_LOCATION: "Room 1",
  OFFER_SALARY: "85,000.00",
  OFFER_CURRENCY: "EUR",
  START_DATE: "15 January 2027",
  LEGAL_ENTITY: "ATS Demo Sp. z o.o.",
  LOGO,
};

describe("token catalogue", () => {
  it("has exactly the 13 §5.1 tokens", () => {
    expect([...TOKENS].sort()).toEqual(
      [
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
      ].sort(),
    );
  });

  it.each(TOKENS.filter((token) => token !== "LOGO"))("resolves [[%s]] in html and text mode", (token) => {
    expect(resolveTokens(`<${token}>[[${token}]]`, VALUES, "text")).toBe(`<${token}>${VALUES[token]}`);
    expect(resolveTokens(`[[${token}]]`, VALUES, "html")).toBe(VALUES[token].replaceAll("&", "&amp;"));
  });

  it("resolves [[LOGO]] to a data: image in html and nothing in text", () => {
    expect(resolveTokens("[[LOGO]]", VALUES, "html")).toBe(`<img src="${LOGO}" alt="Logo">`);
    expect(resolveTokens("a[[LOGO]]b", VALUES, "text")).toBe("ab");
    expect(() => resolveTokens("[[LOGO]]", VALUES, "subject")).toThrow(TokenNotAllowedError);
  });
});

describe("resolveTokens", () => {
  it("HTML-escapes values in html mode", () => {
    const values: TokenValues = { CANDIDATE_FULL_NAME: `<script>alert(1)</script> & "x" 'y'` };
    expect(resolveTokens("Dear [[CANDIDATE_FULL_NAME]]", values, "html")).toBe(
      "Dear &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot; &#39;y&#39;",
    );
    expect(resolveTokens("Dear [[CANDIDATE_FULL_NAME]]", values, "text")).toBe(`Dear <script>alert(1)</script> & "x" 'y'`);
  });

  it("keeps a subject on one line: line breaks in values become spaces", () => {
    const values: TokenValues = { JOB_TITLE: "Engineer\r\nBcc: victim@example.com" };
    const subject = resolveTokens("Your application: [[JOB_TITLE]]", values, "subject");
    expect(subject).toBe("Your application: Engineer Bcc: victim@example.com");
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it.each(["[[FOO]]", "[[job_title]]", "[[ JOB_TITLE ]]", "[[]]"])("throws UnknownTokenError for %s, naming the token", (text) => {
    expect(() => resolveTokens(`Hi ${text}`, VALUES, "text")).toThrow(UnknownTokenError);
  });

  it("names the token, never a value, in its errors", () => {
    const unknown = (() => {
      try {
        resolveTokens("[[FOO]] [[CANDIDATE_FULL_NAME]]", VALUES, "text");
      } catch (err) {
        return err as Error;
      }
    })();
    expect(unknown).toBeInstanceOf(UnknownTokenError);
    expect((unknown as UnknownTokenError).token).toBe("FOO");
    expect(unknown?.message).not.toContain("Ada");
  });

  it("throws MissingTokenValueError for a token without a value; an empty string is a value", () => {
    expect(() => resolveTokens("[[JOB_TITLE]]", {}, "text")).toThrow(MissingTokenValueError);
    expect(() => resolveTokens("[[JOB_TITLE]]", { JOB_TITLE: null }, "text")).toThrow(MissingTokenValueError);
    expect(resolveTokens("[[JOB_TITLE]]", { JOB_TITLE: "" }, "text")).toBe("");
  });

  it("resolves in a single pass: a value containing a token is output literally", () => {
    const values: TokenValues = { CANDIDATE_FULL_NAME: "[[JOB_TITLE]]", JOB_TITLE: "secret" };
    expect(resolveTokens("[[CANDIDATE_FULL_NAME]]", values, "text")).toBe("[[JOB_TITLE]]");
  });

  it("refuses an unclosed [[", () => {
    expect(() => resolveTokens("Hello [[JOB_TITLE", VALUES, "text")).toThrow(UnclosedTokenError);
  });

  it("leaves text without tokens and single brackets alone", () => {
    expect(resolveTokens("a [b] ]] c", {}, "text")).toBe("a [b] ]] c");
  });
});

describe("token scopes", () => {
  it("allows the candidate and requisition tokens in email subjects, plus LOGO in bodies and offer terms in offers", () => {
    expect(TOKEN_SCOPES.emailSubject).not.toContain("LOGO");
    expect(TOKEN_SCOPES.emailBody).toContain("LOGO");
    expect(TOKEN_SCOPES.offerBody).toEqual(expect.arrayContaining(["OFFER_SALARY", "OFFER_CURRENCY", "START_DATE", "LOGO"]));
    for (const scope of Object.values(TOKEN_SCOPES)) {
      expect(scope).not.toContain("INTERVIEW_DATETIME");
      expect(scope).not.toContain("INTERVIEW_LOCATION");
    }
  });

  it("checkTokens refuses a token outside the scope, an unknown token and an unclosed [[", () => {
    expect(() => checkTokens("[[OFFER_SALARY]]", "emailBody")).toThrow(TokenNotAllowedError);
    expect(() => checkTokens("[[LOGO]]", "emailSubject")).toThrow(TokenNotAllowedError);
    expect(() => checkTokens("[[INTERVIEW_DATETIME]]", "offerBody")).toThrow(TokenNotAllowedError);
    expect(() => checkTokens("[[NOPE]]", "offerBody")).toThrow(UnknownTokenError);
    expect(() => checkTokens("[[JOB_TITLE", "emailBody")).toThrow(UnclosedTokenError);
    expect(() => checkTokens("[[OFFER_SALARY]] [[LOGO]] [[JOB_TITLE]]", "offerBody")).not.toThrow();
  });
});

describe("value formats", () => {
  it("formats dates as 15 January 2027", () => {
    expect(formatDate("2027-01-15")).toBe("15 January 2027");
    expect(formatDate("2026-03-01")).toBe("1 March 2026");
    expect(() => formatDate("15/01/2027")).toThrow();
  });

  it("formats amounts as 85,000.00 without a currency", () => {
    expect(formatAmount("85000")).toBe("85,000.00");
    expect(formatAmount(1234567.5)).toBe("1,234,567.50");
    expect(formatAmount("0.1")).toBe("0.10");
  });

  it("formats interview times in the interview's zone with its name, across a DST change", () => {
    // Europe/Warsaw: CET (UTC+1) until 29 March 2026 01:00 UTC, then CEST (UTC+2).
    expect(formatInterviewDateTime(new Date("2027-01-15T13:00:00Z"), "Europe/Warsaw")).toBe("Friday, 15 January 2027, 14:00 (Europe/Warsaw)");
    expect(formatInterviewDateTime(new Date("2026-03-28T13:00:00Z"), "Europe/Warsaw")).toBe("Saturday, 28 March 2026, 14:00 (Europe/Warsaw)");
    expect(formatInterviewDateTime(new Date("2026-03-30T12:00:00Z"), "Europe/Warsaw")).toBe("Monday, 30 March 2026, 14:00 (Europe/Warsaw)");
    expect(formatInterviewDateTime(new Date("2026-03-30T12:00:00Z"), "America/New_York")).toBe("Monday, 30 March 2026, 08:00 (America/New_York)");
  });
});
