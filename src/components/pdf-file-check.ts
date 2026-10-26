// The browser-side upload check shared by Quick Apply and scorecard notes
// (ats-project-scope.md F2): empty and oversized files are refused before
// upload as a convenience; the server validates every upload again.
const BYTES_PER_MB = 1_048_576;

export type PdfFileProblem = "empty" | "tooLarge";

export function pdfFileProblem(file: File | undefined | null, maxMb: number): PdfFileProblem | undefined {
  if (!file) return undefined;
  if (file.size === 0) return "empty";
  if (file.size > maxMb * BYTES_PER_MB) return "tooLarge";
  return undefined;
}
