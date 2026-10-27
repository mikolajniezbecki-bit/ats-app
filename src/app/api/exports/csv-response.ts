// The download response every CSV export returns (V10): an attachment
// named by the Europe/Warsaw date, never cached.
export function csvResponse(file: { csv: string; filename: string }): Response {
  return new Response(file.csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
