// The offer letter layout (tech-stack.md §10 P1, P3, P4, P5; task 37 Q6):
// A4 portrait with 20 mm margins, the logo and the letter date in the
// header, the body in the P3 subset, and the legal entity and "Page n of m"
// in the footer of every page. Layout lives in code (P1); the content comes
// from the offer template, already parsed and with its tokens resolved.
import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { Block, Inline } from "../domain/markup";
import { FONT_FAMILY } from "./fonts";

const MM = 72 / 25.4;

const styles = StyleSheet.create({
  page: { paddingTop: 20 * MM, paddingBottom: 28 * MM, paddingHorizontal: 20 * MM, fontFamily: FONT_FAMILY, fontSize: 11 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 * MM },
  logo: { width: 40 * MM, objectFit: "contain" },
  date: { fontSize: 10 },
  // Line height on the body blocks, not the page: with a page-level lineHeight
  // react-pdf doesn't draw the "Page n of m" render-prop text at all.
  h1: { fontSize: 18, fontWeight: "bold", marginBottom: 8, lineHeight: 1.4 },
  h2: { fontSize: 14, fontWeight: "bold", marginTop: 6, marginBottom: 6, lineHeight: 1.4 },
  paragraph: { marginBottom: 8, lineHeight: 1.4 },
  list: { marginBottom: 8, lineHeight: 1.4 },
  item: { flexDirection: "row" },
  bullet: { width: 12 },
  itemText: { flex: 1 },
  // Two fixed, absolutely placed texts in the bottom margin.
  footerLeft: { position: "absolute", bottom: 12 * MM, left: 20 * MM, fontSize: 9 },
  footerRight: { position: "absolute", bottom: 12 * MM, left: 20 * MM, right: 20 * MM, fontSize: 9, textAlign: "right" },
});

/** One P3 inline run; bold and italic select the matching Noto Sans face, otherwise it inherits (headings are bold). */
function Run({ run }: { run: Inline }) {
  return <Text style={{ ...(run.bold ? { fontWeight: "bold" } : {}), ...(run.italic ? { fontStyle: "italic" } : {}) }}>{run.text}</Text>;
}

const runs = (content: Inline[]) => content.map((run, index) => <Run key={index} run={run} />);

function BlockView({ block }: { block: Block }) {
  if (block.kind === "heading") return <Text style={block.level === 1 ? styles.h1 : styles.h2}>{runs(block.content)}</Text>;
  if (block.kind === "list") {
    return (
      <View style={styles.list}>
        {block.items.map((item, index) => (
          <View key={index} style={styles.item} wrap={false}>
            <Text style={styles.bullet}>•</Text>
            <Text style={styles.itemText}>{runs(item)}</Text>
          </View>
        ))}
      </View>
    );
  }
  // A line break inside a paragraph stays a line break (P3).
  return (
    <Text style={styles.paragraph}>
      {block.lines.map((line, index) => (
        <Text key={index}>
          {index > 0 ? "\n" : ""}
          {runs(line)}
        </Text>
      ))}
    </Text>
  );
}

export type OfferLetterProps = { blocks: Block[]; logo: Buffer; letterDate: string; legalEntityLabel: string };

export function OfferLetter({ blocks, logo, letterDate, legalEntityLabel }: OfferLetterProps) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header} fixed>
          {/* eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, not an HTML img */}
          <Image src={logo} style={styles.logo} />
          <Text style={styles.date}>{letterDate}</Text>
        </View>
        {blocks.map((block, index) => (
          <BlockView key={index} block={block} />
        ))}
        <Text style={styles.footerLeft} fixed>
          {legalEntityLabel}
        </Text>
        <Text style={styles.footerRight} fixed render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
      </Page>
    </Document>
  );
}
