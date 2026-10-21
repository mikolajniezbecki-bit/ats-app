"use client";

// Shown when the root layout itself fails (tech-stack.md §13 M4). The layout's
// NextIntlClientProvider isn't available here, so the text comes straight
// from messages/en.json.
import { useState } from "react";
import messages from "../../messages/en.json";

const text = messages.Error;

export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  // Available only if the root layout rendered before (client navigation).
  const [requestId] = useState(() =>
    typeof document === "undefined" ? undefined : document.body.dataset.requestId,
  );

  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", textAlign: "center", padding: "2rem" }}>
        <title>{text.title}</title>
        <h1>{text.title}</h1>
        <p>{text.description}</p>
        {requestId && <p style={{ fontFamily: "monospace" }}>{text.requestId.replace("{requestId}", requestId)}</p>}
        <button type="button" onClick={() => retry()}>
          {text.retry}
        </button>
      </body>
    </html>
  );
}
