"use client";

// Interviews on the application page (ats-project-scope.md I1–I7): the
// list with times in the viewer's browser zone (I6), and for Admins and
// Recruiters the schedule, edit, cancel and outcome actions. The start is
// entered as a local time in the chosen IANA zone (default: the browser's);
// the API converts and checks everything again.
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { LocalTime } from "@/components/local-time";

export type PanelInterview = {
  id: string;
  startsAtUtc: string;
  startLocal: string;
  durationMinutes: number;
  timezone: string;
  locationOrLink: string;
  status: "SCHEDULED" | "COMPLETED" | "CANCELLED" | "NO_SHOW";
  icsSequence: number;
  awaitingOutcome: boolean;
  started: boolean;
  participants: { userId: string; name: string; isActive: boolean; removed: boolean }[];
};

type Props = {
  applicationId: string;
  interviews: PanelInterview[];
  participantOptions: { id: string; name: string }[];
  canManage: boolean;
  canSchedule: boolean;
  /** I9: participants get a link to their scorecard. */
  currentUserId: string;
};
type ApiError = { message?: string; fields?: Record<string, string> };
type Mode = { kind: "schedule" } | { kind: "edit"; interview: PanelInterview } | { kind: "cancel"; interview: PanelInterview } | null;

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function InterviewsPanel({ applicationId, interviews, participantOptions, canManage, canSchedule, currentUserId }: Props) {
  const t = useTranslations("Interviews");
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(null);
  const [errors, setErrors] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  async function send(url: string, method: string, body: unknown): Promise<boolean> {
    setPending(true);
    setErrors(null);
    const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    setPending(false);
    if (response?.ok) {
      setMode(null);
      router.refresh();
      return true;
    }
    setErrors(((await response?.json().catch(() => null)) as ApiError | null) ?? { message: t("failed") });
    return false;
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mode) return;
    const form = new FormData(event.currentTarget);
    if (mode.kind === "cancel") {
      void send(`/api/interviews/${mode.interview.id}/cancel`, "POST", { expectedSequence: mode.interview.icsSequence });
      return;
    }
    const fields = {
      startLocal: String(form.get("startLocal") ?? ""),
      timezone: String(form.get("timezone") ?? ""),
      durationMinutes: Number(form.get("durationMinutes") ?? 0),
      locationOrLink: String(form.get("locationOrLink") ?? ""),
      participantIds: form.getAll("participantIds").map(String),
    };
    if (mode.kind === "schedule") void send(`/api/applications/${applicationId}/interviews`, "POST", fields);
    else void send(`/api/interviews/${mode.interview.id}`, "PATCH", { expectedSequence: mode.interview.icsSequence, ...fields });
  }

  const open = (next: Mode) => {
    setErrors(null);
    setMode(next);
  };
  const fieldError = (name: string) =>
    errors?.fields?.[name] && (
      <p id={`interview-${name}-error`} role="alert" className="text-sm text-red-700">
        {errors.fields[name]}
      </p>
    );
  const invalid = (name: string) => (errors?.fields?.[name] ? { "aria-invalid": true, "aria-describedby": `interview-${name}-error` } : {});
  const editing = mode?.kind === "edit" ? mode.interview : null;
  const current = new Set(editing?.participants.filter((p) => !p.removed).map((p) => p.userId) ?? []);
  // An edit keeps showing current participants who are no longer pickable (e.g. inactive).
  const options = [
    ...participantOptions,
    ...(editing?.participants.filter((p) => !p.removed && !participantOptions.some((o) => o.id === p.userId)).map((p) => ({ id: p.userId, name: p.name })) ?? []),
  ];

  return (
    <div className="space-y-3">
      {interviews.length === 0 ? (
        <p className="text-sm">{t("empty")}</p>
      ) : (
        <ul className="max-w-4xl space-y-2">
          {interviews.map((interview) => (
            <li key={interview.id} className="rounded border p-3 text-sm" data-testid={`interview-${interview.id}`}>
              <p className="font-medium">
                <LocalTime value={interview.startsAtUtc} /> · {t("durationValue", { minutes: interview.durationMinutes })} · {t(`statuses.${interview.status}`)}
                {interview.awaitingOutcome && <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">{t("awaitingOutcome")}</span>}
              </p>
              <p className="break-all">{interview.locationOrLink}</p>
              <p>
                {t("fields.participants")}:{" "}
                {interview.participants
                  .map((p) => (p.removed ? t("removed", { name: p.name }) : p.isActive ? p.name : t("inactive", { name: p.name })))
                  .join(", ")}
              </p>
              {interview.status !== "CANCELLED" && interview.participants.some((p) => p.userId === currentUserId && !p.removed) && (
                <a href={`/interviews/${interview.id}/scorecard`} className="mt-1 inline-block underline">
                  {t("scorecard")}
                </a>
              )}
              {canManage && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {interview.status === "SCHEDULED" && (
                    <>
                      <button type="button" onClick={() => open({ kind: "edit", interview })} className="rounded border px-3 py-1">
                        {t("edit")}
                      </button>
                      <button type="button" onClick={() => open({ kind: "cancel", interview })} className="rounded border border-red-700 px-3 py-1 text-red-700">
                        {t("cancel")}
                      </button>
                    </>
                  )}
                  {interview.started && interview.status !== "CANCELLED" && (
                    <>
                      {interview.status !== "COMPLETED" && (
                        <button type="button" disabled={pending} onClick={() => void send(`/api/interviews/${interview.id}/outcome`, "POST", { status: "COMPLETED" })} className="rounded border px-3 py-1">
                          {t("completed")}
                        </button>
                      )}
                      {interview.status !== "NO_SHOW" && (
                        <button type="button" disabled={pending} onClick={() => void send(`/api/interviews/${interview.id}/outcome`, "POST", { status: "NO_SHOW" })} className="rounded border px-3 py-1">
                          {t("noShow")}
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && canSchedule && !mode && (
        <button type="button" onClick={() => open({ kind: "schedule" })} className="rounded bg-black px-4 py-2 text-white">
          {t("schedule")}
        </button>
      )}
      {errors?.message && !mode && (
        <p role="alert" className="text-sm text-red-700">
          {errors.message}
        </p>
      )}

      {mode && (
        <form
          onSubmit={onSubmit}
          aria-label={mode.kind === "schedule" ? t("schedule") : mode.kind === "edit" ? t("edit") : t("cancel")}
          className="max-w-xl space-y-3 rounded border p-4"
          noValidate
        >
          {mode.kind !== "cancel" && (
            <>
              <div className="space-y-1">
                <label htmlFor="interview-startLocal" className="block text-sm font-medium">
                  {t("fields.start")}
                </label>
                <input
                  id="interview-startLocal"
                  name="startLocal"
                  type="datetime-local"
                  required
                  defaultValue={editing?.startLocal}
                  {...invalid("startLocal")}
                  className="w-full rounded border px-3 py-2"
                />
                {fieldError("startLocal")}
              </div>
              <div className="space-y-1">
                <label htmlFor="interview-timezone" className="block text-sm font-medium">
                  {t("fields.timezone")}
                </label>
                <select id="interview-timezone" name="timezone" defaultValue={editing?.timezone ?? browserZone()} {...invalid("timezone")} className="w-full rounded border px-3 py-2">
                  {[...new Set([editing?.timezone ?? browserZone(), ...timeZones()])].map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
                {fieldError("timezone")}
              </div>
              <div className="space-y-1">
                <label htmlFor="interview-durationMinutes" className="block text-sm font-medium">
                  {t("fields.duration")}
                </label>
                <input
                  id="interview-durationMinutes"
                  name="durationMinutes"
                  type="number"
                  min={15}
                  max={480}
                  step={5}
                  required
                  defaultValue={editing?.durationMinutes ?? 60}
                  {...invalid("durationMinutes")}
                  className="w-full rounded border px-3 py-2"
                />
                {fieldError("durationMinutes")}
              </div>
              <div className="space-y-1">
                <label htmlFor="interview-locationOrLink" className="block text-sm font-medium">
                  {t("fields.location")}
                </label>
                <input
                  id="interview-locationOrLink"
                  name="locationOrLink"
                  required
                  maxLength={500}
                  defaultValue={editing?.locationOrLink}
                  {...invalid("locationOrLink")}
                  className="w-full rounded border px-3 py-2"
                />
                {fieldError("locationOrLink")}
              </div>
              <fieldset className="space-y-1" {...invalid("participantIds")}>
                <legend className="text-sm font-medium">{t("fields.participants")}</legend>
                {options.map((option) => (
                  <label key={option.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="participantIds" value={option.id} defaultChecked={current.has(option.id)} />
                    {option.name}
                  </label>
                ))}
                {fieldError("participantIds")}
              </fieldset>
            </>
          )}
          {errors?.message && !errors.fields && (
            <p role="alert" className="text-sm text-red-700">
              {errors.message}
            </p>
          )}
          <div className="flex gap-2">
            <button type="submit" disabled={pending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-60">
              {mode.kind === "schedule" ? t("saveSchedule") : mode.kind === "edit" ? t("save") : t("confirmCancel")}
            </button>
            <button type="button" onClick={() => setMode(null)} className="rounded border px-4 py-2">
              {t("close")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
