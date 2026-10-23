"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

/**
 * Opens a PDF attachment inline: asks GET /api/files/[id]/url for a fresh
 * 5-minute signed link (V11) and points a new tab at it. The tab is opened
 * on the click itself, so popup blockers allow it.
 */
export function OpenAttachmentButton({ fileId, name }: { fileId: string; name: string }) {
  const t = useTranslations("AdminOutbox");
  const [failed, setFailed] = useState(false);

  async function open() {
    setFailed(false);
    const tab = window.open("", "_blank");
    const response = await fetch(`/api/files/${fileId}/url`).catch(() => null);
    const body = response?.ok ? ((await response.json()) as { url: string }) : null;
    if (!tab || !body) {
      tab?.close();
      setFailed(true);
      return;
    }
    tab.opener = null;
    tab.location.href = body.url;
  }

  return (
    <>
      <button type="button" onClick={open} className="rounded border px-2 py-1" aria-label={t("openAttachment", { name })}>
        {t("open")}
      </button>
      {failed && (
        <span role="alert" className="text-red-700">
          {t("openFailed")}
        </span>
      )}
    </>
  );
}
