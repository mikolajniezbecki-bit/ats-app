// CSV files for hand-off (ats-project-scope.md V10, task 39 Q3): UTF-8 with
// a byte-order mark so spreadsheets read the diacritics, CRLF line ends and
// RFC 4180 quoting. Text cells that a spreadsheet would run as a formula get
// a leading `'`; columns whose format §7 already restricts (phone numbers)
// are marked `raw` and kept as they are. Pure, so task 41's exports reuse it.

export type CsvColumn = { header: string; /** Skip the formula prefix (the value's format is restricted elsewhere). */ raw?: boolean };

const BOM = "\uFEFF";
const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell: formula-safe unless `raw`, quoted when it holds a comma, quote or line break. */
export function csvCell(value: string | null | undefined, raw = false): string {
  let text = value ?? "";
  if (!raw && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The whole file: BOM, the header row, then one CRLF-terminated line per row. */
export function toCsv(columns: readonly CsvColumn[], rows: readonly (readonly (string | null)[])[]): string {
  const lines = [columns.map((column) => csvCell(column.header)), ...rows.map((row) => columns.map((column, i) => csvCell(row[i], column.raw)))];
  return BOM + lines.map((cells) => `${cells.join(",")}\r\n`).join("");
}
