"use client";

// Admin "Reopen" on a submitted scorecard (ats-project-scope.md V8); the API
// refuses it on a closed application and shows why.
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function ReopenScorecardButton({ scorecardId }: { scorecardId: string }) {
  const t = useTranslations("Feedback");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function reopen() {
    setPending(true);
    setError(null);
    const response = await fetch(`/api/scorecards/${scorecardId}/reopen`, { method: "POST" }).catch(() => null);
    setPending(false);
    if (response?.ok) {
      router.refresh();
      return;
    }
    const body = (await response?.json().catch(() => null)) as { message?: string } | null;
    setError(body?.message ?? t("reopenFailed"));
  }

  return (
    <span className="ml-2 inline-flex flex-col">
      <button type="button" disabled={pending} onClick={() => void reopen()} className="rounded border px-2 py-0.5 text-xs">
        {t("reopen")}
      </button>
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </span>
  );
}
