"use client";

// Bulk actions on the application list (ats-project-scope.md §5.4 Bulk
// actions): row checkboxes, "Select all on this page", and a bar with
// "Move status" and "Send email". Each action asks for confirmation, calls
// the bulk API once, and shows one result per application. Moved rows are
// unselected and the list reloads; refused rows stay selected. The API
// checks everything again.
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { type ReactNode, createContext, useContext, useRef, useState } from "react";

type Item = { id: string; version: number; name: string };
type Template = { id: string; name: string; subject: string; body: string };
type Result = { applicationId: string; ok: boolean; status?: string; message?: string; emailLogId?: string; name?: string };

type Selection = { selected: Set<string>; toggle: (id: string, on: boolean) => void; setAll: (on: boolean) => void; items: Item[] };
const SelectionContext = createContext<Selection | null>(null);

function useSelection(): Selection {
  const selection = useContext(SelectionContext);
  if (!selection) throw new Error("Bulk selection used outside BulkProvider");
  return selection;
}

export function BulkProvider({ items, children }: { items: Item[]; children: ReactNode }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const known = new Set(items.map((item) => item.id));
  // Rows that left the page (filter, paging, reload) drop out of the selection.
  const current = new Set([...selected].filter((id) => known.has(id)));
  const toggle = (id: string, on: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const setAll = (on: boolean) => setSelected(on ? new Set(items.map((item) => item.id)) : new Set());
  return <SelectionContext.Provider value={{ selected: current, toggle, setAll, items }}>{children}</SelectionContext.Provider>;
}

export function BulkRowCheckbox({ id, name }: { id: string; name: string }) {
  const t = useTranslations("Bulk");
  const { selected, toggle } = useSelection();
  return <input type="checkbox" aria-label={t("selectRow", { name })} checked={selected.has(id)} onChange={(event) => toggle(id, event.target.checked)} className="h-4 w-4" />;
}

export function BulkSelectAll() {
  const t = useTranslations("Bulk");
  const { selected, setAll, items } = useSelection();
  const all = items.length > 0 && selected.size === items.length;
  return <input type="checkbox" aria-label={t("selectAll")} checked={all} onChange={(event) => setAll(event.target.checked)} className="h-4 w-4" />;
}

type Mode = "move" | "email" | null;

export function BulkBar({ templates, statusLabels }: { templates: Template[]; statusLabels: Record<string, string> }) {
  const t = useTranslations("Bulk");
  const router = useRouter();
  const { selected, toggle, items } = useSelection();
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [toStatus, setToStatus] = useState("");
  const [comment, setComment] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<{ mode: Exclude<Mode, null>; rows: Result[] } | null>(null);
  const chosen = items.filter((item) => selected.has(item.id));
  const template = templates.find((entry) => entry.id === templateId);
  const names = new Map(items.map((item) => [item.id, item.name]));

  function open(next: Exclude<Mode, null>) {
    setMode(next);
    setError(null);
    setResults(null);
    dialog.current?.showModal();
  }

  function close() {
    dialog.current?.close();
    setMode(null);
  }

  async function run() {
    if (!mode) return;
    setPending(true);
    setError(null);
    const [url, body] =
      mode === "move"
        ? ["/api/applications/bulk/status", { toStatus, ...(comment.trim() ? { comment } : {}), items: chosen.map((item) => ({ applicationId: item.id, version: item.version })) }]
        : ["/api/applications/bulk/email", { templateId, applicationIds: chosen.map((item) => item.id) }];
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const json = (await response?.json().catch(() => null)) as { results?: Result[]; message?: string } | null;
    setPending(false);
    if (!response?.ok || !json?.results) {
      setError(json?.message ?? t("requestFailed"));
      return;
    }
    for (const row of json.results) if (row.ok) toggle(row.applicationId, false);
    // Names as they were when sent: a moved row may leave a filtered list.
    setResults({ mode, rows: json.results.map((row) => ({ ...row, name: names.get(row.applicationId) })) });
    router.refresh();
  }

  const ready = mode === "move" ? toStatus !== "" : templateId !== "";
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="bulk-bar">
      <span aria-live="polite">{t("selected", { count: selected.size })}</span>
      <button type="button" disabled={selected.size === 0} onClick={() => open("move")} className="rounded border px-3 py-1 disabled:opacity-50">
        {t("move")}
      </button>
      <button type="button" disabled={selected.size === 0} onClick={() => open("email")} className="rounded border px-3 py-1 disabled:opacity-50">
        {t("email")}
      </button>
      <dialog ref={dialog} aria-labelledby="bulk-dialog-title" onClose={() => setMode(null)} className="w-full max-w-2xl rounded border p-4 backdrop:bg-black/30">
        {mode && (
          <div className="space-y-3">
            <h2 id="bulk-dialog-title" className="text-lg font-semibold">
              {mode === "move" ? t("moveTitle") : t("emailTitle")}
            </h2>
            {!results && mode === "move" && (
              <>
                <label htmlFor="bulk-status" className="block font-medium">
                  {t("target")}
                </label>
                <select id="bulk-status" value={toStatus} onChange={(event) => setToStatus(event.target.value)} className="w-full rounded border px-3 py-2">
                  <option value="">{t("choose")}</option>
                  {Object.entries(statusLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <label htmlFor="bulk-comment" className="block font-medium">
                  {t("comment")}
                </label>
                <textarea id="bulk-comment" rows={3} maxLength={2000} value={comment} onChange={(event) => setComment(event.target.value)} className="w-full rounded border px-3 py-2" />
                {toStatus && <p className="font-medium">{t("confirmMove", { count: chosen.length, status: statusLabels[toStatus] })}</p>}
              </>
            )}
            {!results && mode === "email" && (
              <>
                {templates.length === 0 ? (
                  <p>{t("noTemplates")}</p>
                ) : (
                  <>
                    <label htmlFor="bulk-template" className="block font-medium">
                      {t("template")}
                    </label>
                    <select id="bulk-template" value={templateId} onChange={(event) => setTemplateId(event.target.value)} className="w-full rounded border px-3 py-2">
                      <option value="">{t("chooseTemplate")}</option>
                      {templates.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                {template && (
                  <section aria-label={t("preview")} className="space-y-1 rounded border bg-gray-50 p-3">
                    <p className="text-xs">{t("preview")}</p>
                    <p>
                      <span className="font-medium">{t("previewSubject")}:</span> {template.subject}
                    </p>
                    <p className="font-medium">{t("previewBody")}:</p>
                    <pre className="whitespace-pre-wrap font-sans">{template.body}</pre>
                    <p className="font-medium">{t("confirmEmail", { name: template.name, count: chosen.length })}</p>
                  </section>
                )}
              </>
            )}
            {error && (
              <p role="alert" className="text-red-700">
                {error}
              </p>
            )}
            {results && (
              <section aria-labelledby="bulk-results-title" className="space-y-2">
                <h3 id="bulk-results-title" className="font-semibold">
                  {t("resultsTitle")}
                </h3>
                <table className="w-full text-left" data-testid="bulk-results">
                  <thead>
                    <tr className="border-b">
                      <th className="py-1 pr-4">{t("candidate")}</th>
                      <th className="py-1">{t("result")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.rows.map((row) => (
                      <tr key={row.applicationId} className="border-b">
                        <td className="py-1 pr-4">{row.name ?? row.applicationId}</td>
                        <td className={`py-1 ${row.ok ? "" : "text-red-700"}`}>
                          {row.ok ? (results.mode === "move" ? t("moved", { status: statusLabels[row.status!] ?? row.status! }) : t("queued")) : row.message}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {results.mode === "email" && <p>{t("queuedNote")}</p>}
              </section>
            )}
            <div className="flex gap-2">
              {!results && (
                <button type="button" disabled={!ready || pending} onClick={() => void run()} className="rounded bg-black px-4 py-2 text-white disabled:opacity-60">
                  {pending ? t("working") : t("confirm")}
                </button>
              )}
              <button type="button" onClick={close} className="rounded border px-4 py-2">
                {results ? t("close") : t("cancel")}
              </button>
            </div>
          </div>
        )}
      </dialog>
    </div>
  );
}
