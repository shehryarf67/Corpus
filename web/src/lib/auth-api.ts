import "server-only";

import { cookies } from "next/headers";
import { requestRaw } from "./api";

const SESSION_COOKIE = "corpus_session";

export type AuthUser = {
  id: string;
  email: string;
  created_at: string;
};

type AuthResponse = {
  user: AuthUser;
  sessionExpiresAt: string;
};

type LogoutResponse = { ok: boolean };

/**
 * Auth requests run on the Next server, so their Set-Cookie header does not
 * reach the browser automatically. Copy the backend session cookie into
 * Next's response cookie store after login, signup, and logout.
 */
async function copySessionCookie(response: Response): Promise<void> {
  const setCookieHeader = response.headers.get("set-cookie");
  if (!setCookieHeader) return;

  const parts = setCookieHeader.split(";").map((part) => part.trim());
  const nameValue = parts[0];
  if (!nameValue) return;

  const equalsIndex = nameValue.indexOf("=");
  if (equalsIndex < 0) return;

  const name = nameValue.slice(0, equalsIndex);
  const value = nameValue.slice(equalsIndex + 1);
  if (name !== SESSION_COOKIE) return;

  const options: {
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "lax" | "strict" | "none";
    path?: string;
    expires?: Date;
    maxAge?: number;
  } = {};

  // Preserve the backend's cookie policy instead of maintaining a different
  // set of security and expiry settings in the frontend.
  for (const attribute of parts.slice(1)) {
    const [rawName, ...rawValueParts] = attribute.split("=");
    const attributeName = rawName?.toLowerCase();
    const attributeValue = rawValueParts.join("=");

    if (attributeName === "httponly") options.httpOnly = true;
    if (attributeName === "secure") options.secure = true;
    if (attributeName === "path" && attributeValue) options.path = attributeValue;
    if (attributeName === "max-age" && attributeValue) {
      options.maxAge = Number(attributeValue);
    }
    if (attributeName === "expires" && attributeValue) {
      options.expires = new Date(attributeValue);
    }
    if (attributeName === "samesite") {
      const sameSite = attributeValue.toLowerCase();
      if (sameSite === "lax" || sameSite === "strict" || sameSite === "none") {
        options.sameSite = sameSite;
      }
    }
  }

  const cookieStore = await cookies();
  cookieStore.set(name, value, options);
}

async function submitCredentials(
  path: "/auth/signup" | "/auth/login",
  email: string,
  password: string,
): Promise<AuthResponse> {
  const response = await requestRaw(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  await copySessionCookie(response);
  return (await response.json()) as AuthResponse;
}

export function signup(email: string, password: string): Promise<AuthResponse> {
  return submitCredentials("/auth/signup", email, password);
}

export function login(email: string, password: string): Promise<AuthResponse> {
  return submitCredentials("/auth/login", email, password);
}

export async function logout(): Promise<LogoutResponse> {
  const response = await requestRaw("/auth/logout", { method: "POST" });
  await copySessionCookie(response);
  return (await response.json()) as LogoutResponse;
}
