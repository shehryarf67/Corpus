"use server";

import { redirect } from "next/navigation";
import { ApiError } from "@/lib/api-error";
import { login, signup } from "@/lib/auth-api";

type AuthActionState = { error: string | null };

function readCredentials(formData: FormData) {
  const email = formData.get("email");
  const password = formData.get("password");

  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    !email.trim() ||
    !email.includes("@") ||
    password.length < 8
  ) {
    return null;
  }

  return { email, password };
}

async function runAuthAction(
  mode: "signin" | "signup",
  formData: FormData,
): Promise<AuthActionState> {
  const credentials = readCredentials(formData);
  if (!credentials) {
    return { error: "Enter a valid email and a password of at least 8 characters." };
  }

  try {
    if (mode === "signup") {
      await signup(credentials.email, credentials.password);
    } else {
      await login(credentials.email, credentials.password);
    }
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    console.error(`${mode} action failed`, error);
    return { error: "Authentication is unavailable right now. Please try again." };
  }

  // redirect() throws internally, so it must stay outside the catch block.
  redirect("/documents");
}

export async function loginAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  return await runAuthAction("signin", formData);
}

export async function signupAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  return await runAuthAction("signup", formData);
}
