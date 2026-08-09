import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { ApiError } from "./api-error";
import { request } from "./api";
import type { AuthUser } from "./auth-api";

type MeResponse = { user: AuthUser };

/**
 * The DAL is the frontend's single place for loading the authenticated user.
 * React cache avoids repeating /auth/me during the same server render.
 */
export const getCurrentUser = cache(async (): Promise<AuthUser | null> => {
  try {
    const response = await request<MeResponse>("/auth/me");
    return response.user;
  } catch (error) {
    // No session is a normal state. Other API failures should remain visible.
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
});

/** Protected server UI can call this instead of repeating redirect checks. */
export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}
