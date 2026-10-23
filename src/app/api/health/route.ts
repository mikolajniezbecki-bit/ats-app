// GET /api/health (tech-stack.md M5): public (proxy.ts list), used by the
// deploy smoke test and the readiness and startup probes.
import { runHealthChecks } from "@/server/health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const { httpStatus, body } = await runHealthChecks();
  return Response.json(body, { status: httpStatus, headers: { "Cache-Control": "no-store" } });
}
