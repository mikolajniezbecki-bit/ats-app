// The offer letter renderer (tech-stack.md §10 P2–P5, P8): pure input to PDF
// bytes, inspected with unpdf (text, font names per run) and pdf-lib (the logo
// image), without a database.
import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { extractText, getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";
import { SEED_TEMPLATES } from "@/server/db/seed/data";
import { renderOfferLetter } from "@/server/pdf";

const BASE = { values: {}, legalEntityLabel: "Demo Sp. z o.o.", letterDate: "15 January 2027" };
const render = (body: string, values: Record<string, string> = {}) => renderOfferLetter({ ...BASE, body, values });

/** Every text run of every page with the font it uses, e.g. "NotoSans-Bold". */
async function runs(bytes: Uint8Array) {
  const pdf = await getDocumentProxy(bytes.slice(), { fontExtraProperties: true });
  const result: { text: string; font: string; page: number }[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    await page.getOperatorList();
    const content = await page.getTextContent();
    for (const item of content.items as { str: string; fontName: string }[]) {
      if (!item.str.trim()) continue;
      const name = (page.commonObjs.get(item.fontName) as { name?: string }).name ?? "";
      result.push({ text: item.str, font: name.replace(/^[A-Z]{6}\+/, ""), page: n });
    }
  }
  return result;
}

const text = async (bytes: Uint8Array) => (await extractText(bytes.slice(), { mergePages: true })).text as string;
const fontOf = async (bytes: Uint8Array, needle: string) => (await runs(bytes)).find((run) => run.text.includes(needle))?.font;

describe("tokens (P2)", () => {
  it("P2: an unknown token, an unclosed [[ or a known token without a value throws naming the token; nothing is rendered", async () => {
    await expect(render("Hello [[UNKNOWN]]")).rejects.toThrow("[[UNKNOWN]]");
    await expect(render("Hello [[JOB_TITLE")).rejects.toThrow("Unclosed [[");
    await expect(render("Start [[START_DATE]]")).rejects.toThrow("[[START_DATE]]");
  });

  it("P2: a candidate named **Jan** <b>Kowalski</b> & Co appears literally and isn't bold", async () => {
    const name = "**Jan** <b>Kowalski</b> & Co";
    const bytes = await render("Dear [[CANDIDATE_FULL_NAME]],", { CANDIDATE_FULL_NAME: name });
    expect(await text(bytes)).toContain(`Dear ${name},`);
    expect(await fontOf(bytes, "Kowalski")).toBe("NotoSans-Regular");
  });

  it("P2, Q2: [[LOGO]] is empty in the letter, because the layout shows the logo", async () => {
    const extracted = await text(await render("Before[[LOGO]]After"));
    expect(extracted).toContain("BeforeAfter");
    expect(extracted).not.toContain("data:image");
  });
});

describe("markup (P3)", () => {
  it("P3: headings, bold, italic and a list render with their styles", async () => {
    const bytes = await render("# Big heading\n\n## Small heading\n\nPlain **strong** and *slanted* text\nsecond line\n\n- first item\n- second item");
    const extracted = await text(bytes);
    for (const part of ["Big heading", "Small heading", "Plain", "second line", "• first item", "• second item"]) expect(extracted).toContain(part);
    expect(await fontOf(bytes, "Big heading")).toBe("NotoSans-Bold");
    expect(await fontOf(bytes, "Small heading")).toBe("NotoSans-Bold");
    expect(await fontOf(bytes, "strong")).toBe("NotoSans-Bold");
    expect(await fontOf(bytes, "slanted")).toBe("NotoSans-Italic");
    expect(await fontOf(bytes, "Plain")).toBe("NotoSans-Regular");
  });

  it("P3: links, quotes, numbered lists and raw HTML appear as plain text", async () => {
    const bytes = await render("[link](https://example.com)\n\n> quote\n\n1. numbered\n\n<i>x</i>");
    const extracted = await text(bytes);
    for (const part of ["[link](https://example.com)", "> quote", "1. numbered", "<i>x</i>"]) expect(extracted).toContain(part);
    expect(await fontOf(bytes, "<i>x</i>")).toBe("NotoSans-Regular");
  });
});

describe("layout (P1, P4, P5)", () => {
  it("P4: Polish diacritics come out as written", async () => {
    expect(await text(await render("Zażółć gęślą jaźń ŻÓŁĆ"))).toContain("Zażółć gęślą jaźń ŻÓŁĆ");
  });

  it("P1: the header has the letter date, every page's footer the legal entity and Page n of m", async () => {
    const bytes = await render(`${"A long paragraph of offer text that needs more than one page. ".repeat(50)}`);
    const pdf = await extractText(bytes.slice(), { mergePages: false });
    const pages = pdf.text as string[];
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain("15 January 2027");
    expect(pages[0]).toContain("Page 1 of 2");
    expect(pages[1]).toContain("Page 2 of 2");
    for (const page of pages) expect(page).toContain("Demo Sp. z o.o.");
  });

  it("P5: the first page has an image XObject with the pixel size of /public/logo.png", async () => {
    const png = readFileSync("public/logo.png");
    const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    const doc = await PDFDocument.load(await render("Body"));
    const xObjects = doc.getPages()[0].node.Resources()?.lookup(PDFName.of("XObject"));
    const images = (xObjects ? (xObjects as unknown as { entries(): [PDFName, unknown][] }).entries() : [])
      .map(([, ref]) => doc.context.lookup(ref as never))
      .filter((object): object is PDFRawStream => object instanceof PDFRawStream && object.dict.get(PDFName.of("Subtype"))?.toString() === "/Image");
    expect(images.map((image) => [Number(image.dict.get(PDFName.of("Width"))?.toString()), Number(image.dict.get(PDFName.of("Height"))?.toString())])).toContainEqual([width, height]);
  });
});

describe("snapshot (P8)", () => {
  it("P8: the seeded Default offer letter with fixed values gives the committed text, with every token resolved", async () => {
    const template = SEED_TEMPLATES.find((row) => row.type === "OFFER" && row.name === "Default offer letter") as { body: string };
    const bytes = await renderOfferLetter({
      body: template.body,
      values: {
        CANDIDATE_FULL_NAME: "Ada Lovelace",
        JOB_TITLE: "Backend Engineer",
        REQ_NUMBER: "REQ-00042",
        HIRING_MGR_FULL_NAME: "Grace Hopper",
        RECRUITER_FULL_NAME: "Alan Turing",
        RECRUITER_EMAIL: "alan@example.com",
        LEGAL_ENTITY: "Demo Sp. z o.o.",
        OFFER_SALARY: "85,000.00",
        OFFER_CURRENCY: "EUR",
        START_DATE: "1 March 2027",
      },
      legalEntityLabel: "Demo Sp. z o.o.",
      letterDate: "15 January 2027",
    });
    const extracted = await text(bytes);
    expect(extracted).not.toContain("[[");
    expect(extracted).toMatchSnapshot();
  });
});
