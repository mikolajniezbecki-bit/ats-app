// tech-stack.md §3 rule 6. For now only (b), the request ID (M3); task 10 adds
// the session-cookie check and the CSP.
import { NextResponse, type NextRequest } from "next/server";
import { REQUEST_ID_HEADER, assignRequestId } from "@/server/request-id";

export function proxy(request: NextRequest) {
  const { requestId, requestHeaders } = assignRequestId(request.headers);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

export const config = {
  // Static assets don't need a request ID.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
