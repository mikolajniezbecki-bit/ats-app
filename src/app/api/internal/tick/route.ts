// The hourly tick (tech-stack.md W4). Protected by its own secret, not a
// session; the logic lives in src/server/domain/tick.ts.
import { handleTick } from "@/server/domain/tick";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return handleTick(request);
}
