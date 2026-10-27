// The CSV writer (ats-project-scope.md V10, task 39 Q3): BOM, CRLF, RFC 4180
// quoting, the spreadsheet-formula prefix and the phone exemption.
import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "@/server/exports/csv";
import { HIRE_COLUMNS } from "@/server/exports/hires";

describe("csvCell", () => {
  it("quotes fields with a comma, a quote or a line break and doubles the quotes", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("Kowalski, Jan")).toBe('"Kowalski, Jan"');
    expect(csvCell('Jan "JK" Kowalski')).toBe('"Jan ""JK"" Kowalski"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("two\r\nlines")).toBe('"two\r\nlines"');
    expect(csvCell(null)).toBe("");
    expect(csvCell("Zażółć gęślą jaźń")).toBe("Zażółć gęślą jaźń");
  });

  it("prefixes text starting with =, +, -, @, tab or carriage return with '", () => {
    for (const start of ["=", "+", "-", "@"]) expect(csvCell(`${start}SUM(A1)`), start).toBe(`'${start}SUM(A1)`);
    expect(csvCell("\tcmd")).toBe("'\tcmd");
    expect(csvCell("\rcmd")).toBe(`"'\rcmd"`);
    expect(csvCell("a=b")).toBe("a=b");
  });

  it('exports =HYPERLINK("x") as a quoted, prefixed text cell', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });

  it("keeps a raw cell (phone) as it is", () => {
    expect(csvCell("+48 600 000 000", true)).toBe("+48 600 000 000");
    expect(csvCell("+48 600 000 000")).toBe("'+48 600 000 000");
  });
});

describe("toCsv", () => {
  it("starts with a byte-order mark and ends every line with CRLF", () => {
    const csv = toCsv([{ header: "Name" }, { header: "Phone", raw: true }], [["=cmd", "+48 600 000 000"], ["Ada", null]]);
    expect(csv).toBe("\uFEFFName,Phone\r\n'=cmd,+48 600 000 000\r\nAda,\r\n");
  });

  it("an empty export is the header row only", () => {
    expect(toCsv(HIRE_COLUMNS, [])).toBe(
      "\uFEFFApplication ID,Requisition number,First name,Last name,Email,Phone,Job title,Department,Location,Legal entity,Start date,Salary,Currency,Hired date\r\n",
    );
  });

  it("only the hire export's Phone column is raw", () => {
    expect(HIRE_COLUMNS.filter((column) => column.raw).map((column) => column.header)).toEqual(["Phone"]);
  });
});
