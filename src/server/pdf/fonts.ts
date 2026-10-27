// Noto Sans for the offer letter (tech-stack.md P4, task 37 Q10): the four
// committed faces, registered with absolute paths, so Polish and other Latin
// diacritics render. The folder is in next.config.ts outputFileTracingIncludes,
// so the files are in the standalone output. The OFL licence is next to them.
import path from "node:path";
import { Font } from "@react-pdf/renderer";

export const FONT_FAMILY = "Noto Sans";

const FONT_DIR = path.join(process.cwd(), "src", "server", "pdf", "fonts");

let registered = false;

export function registerFonts(): void {
  if (registered) return;
  Font.register({
    family: FONT_FAMILY,
    fonts: [
      { src: path.join(FONT_DIR, "NotoSans-Regular.ttf"), fontWeight: "normal", fontStyle: "normal" },
      { src: path.join(FONT_DIR, "NotoSans-Bold.ttf"), fontWeight: "bold", fontStyle: "normal" },
      { src: path.join(FONT_DIR, "NotoSans-Italic.ttf"), fontWeight: "normal", fontStyle: "italic" },
      { src: path.join(FONT_DIR, "NotoSans-BoldItalic.ttf"), fontWeight: "bold", fontStyle: "italic" },
    ],
  });
  // No automatic hyphenation: words are broken only at spaces.
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}
