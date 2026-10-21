"use client";

// Generic error page (tech-stack.md §13 M4): never the error message or stack,
// only the request ID that the server logged with the error.
import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

export default function ErrorPage({ retry }: { error: unknown; retry: () => void }) {
  const t = useTranslations("Error");
  // Set by the root layout for the document request.
  const requestId = useSyncExternalStore(
    subscribe,
    () => document.body.dataset.requestId ?? null,
    () => null,
  );

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p>{t("description")}</p>
      {requestId && <p className="font-mono text-sm">{t("requestId", { requestId })}</p>}
      <button type="button" className="rounded border px-4 py-2" onClick={() => retry()}>
        {t("retry")}
      </button>
    </main>
  );
}
