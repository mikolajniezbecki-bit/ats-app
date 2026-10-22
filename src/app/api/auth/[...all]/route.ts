// Better Auth's endpoints (tech-stack.md §4). The instance is created on the
// first request, never at build time (W1).
import { getAuth } from "@/server/auth/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return getAuth().handler(request);
}

export function POST(request: Request): Promise<Response> {
  return getAuth().handler(request);
}
