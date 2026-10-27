// The offer letter renderer (tech-stack.md §10 P1–P5; ats-project-scope.md
// §5.1 Output): offer template text in, PDF bytes out. Pure apart from
// reading the committed fonts and the logo. The body is parsed with the P3
// parser first and the tokens are then resolved inside each text run (markup
// first, then tokens), so a value is never read as markup. An unknown token,
// an unclosed `[[` or a known token without a value throws before anything
// is rendered.
import { readFileSync } from "node:fs";
import path from "node:path";
import { type Block, type Inline, parseMarkup } from "../domain/markup";
import { type TokenValues, resolveTokens } from "../domain/tokens";

export type OfferLetterInput = {
  body: string;
  values: TokenValues;
  legalEntityLabel: string;
  /** Already formatted, e.g. `15 January 2027`. */
  letterDate: string;
};

let logo: Buffer | undefined;
/** P5: the logo from /public/logo.png, read once. */
function readLogo(): Buffer {
  logo ??= readFileSync(path.join(process.cwd(), "public", "logo.png"));
  return logo;
}

/** Resolves tokens in every text run; throws naming the first bad token. */
function resolveBlocks(blocks: Block[], values: TokenValues): Block[] {
  const run = (inline: Inline): Inline => ({ ...inline, text: resolveTokens(inline.text, values, "text") });
  return blocks.map((block) => {
    if (block.kind === "heading") return { ...block, content: block.content.map(run) };
    if (block.kind === "list") return { ...block, items: block.items.map((item) => item.map(run)) };
    return { ...block, lines: block.lines.map((line) => line.map(run)) };
  });
}

export async function renderOfferLetter(input: OfferLetterInput): Promise<Uint8Array> {
  // Q2: the layout shows the logo, so [[LOGO]] is empty inside the letter.
  const blocks = resolveBlocks(parseMarkup(input.body), { ...input.values, LOGO: "" });
  // Loaded on first use, as ESM: @react-pdf's packages export only the
  // "import" condition, so a CommonJS require (e.g. `pnpm worker`, where tsx
  // compiles this project as CommonJS) can't load them; dynamic import can.
  // It also keeps the renderer out of processes that never render.
  const [{ renderToBuffer }, { OfferLetter }, { registerFonts }] = await Promise.all([import("@react-pdf/renderer"), import("./OfferLetter"), import("./fonts")]);
  registerFonts();
  const bytes = await renderToBuffer(OfferLetter({ blocks, logo: readLogo(), letterDate: input.letterDate, legalEntityLabel: input.legalEntityLabel }));
  return new Uint8Array(bytes);
}
