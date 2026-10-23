// Admin settings API (ats-project-scope.md §5.1): GET lists every setting
// with its effective value, PUT saves the changed keys (all or nothing).
import { withTransaction } from "@/server/db";
import { message } from "@/server/messages";
import { withPermission } from "@/server/policy/guards";
import { listSettings, updateSettings } from "@/server/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withPermission("settings.manage", async () => Response.json({ settings: await listSettings() }));

export const PUT = withPermission("settings.manage", async (request, user) => {
  const body: unknown = await request.json().catch(() => undefined);
  const result = await withTransaction((tx) => updateSettings(tx, user.id, body));
  if (!result.ok) {
    // A key's own error has its own text; the privacy and unknown-key errors are shared.
    const fields = Object.fromEntries(
      Object.entries(result.errors).map(([key, code]) => [
        key,
        message(`AdminSettings.errors.${code === "invalid" && key !== "_" ? key : code}`),
      ]),
    );
    return Response.json({ error: "invalid", fields }, { status: 400 });
  }
  return Response.json({ changed: result.changed });
});
