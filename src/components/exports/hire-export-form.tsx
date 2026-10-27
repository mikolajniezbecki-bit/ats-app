"use client";

// The hire export form (task 39 Q1): a plain form POST, so the browser
// downloads the CSV itself; the checkbox only switches the action's query
// (`?includeExported=true`), which the API reads.
import { useTranslations } from "next-intl";
import { useState } from "react";

export function HireExportForm() {
  const t = useTranslations("Exports.hires");
  const [includeExported, setIncludeExported] = useState(false);
  return (
    <form method="post" action={includeExported ? "/api/exports/hires?includeExported=true" : "/api/exports/hires"} aria-label={t("title")} className="space-y-3 rounded border p-4">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={includeExported} onChange={(event) => setIncludeExported(event.target.checked)} />
        {t("includeExported")}
      </label>
      <button type="submit" className="rounded bg-black px-4 py-2 text-white">
        {t("submit")}
      </button>
    </form>
  );
}
