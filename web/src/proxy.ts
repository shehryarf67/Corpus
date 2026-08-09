import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const SESSION_COOKIE = "corpus_session";

/**
 * This is only an optimistic early check. A cookie being present does not mean
 * it is valid, so the protected layout still calls the DAL's requireUser().
 */
export function proxy(request: NextRequest) {
  if (!request.cookies.has(SESSION_COOKIE)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

// Limit Proxy to protected UI instead of running it for every page and asset.
export const config = {
  matcher: ["/documents/:path*"],
};
