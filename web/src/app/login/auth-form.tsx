"use client";

import { useActionState, useState } from "react";
import {
  loginAction,
  signupAction,
} from "./actions";

type Mode = "signin" | "signup";
type AuthActionState = { error: string | null };

const fieldClass = "mb-[14px]";
const labelClass =
  "mb-[7px] block font-mono text-[10.5px] tracking-[0.13em] uppercase text-graphite-dim";
const inputClass =
  "w-full rounded-[3px] border border-rule-strong bg-chrome px-[13px] py-[11px] text-[14px] text-bone transition-colors duration-150 placeholder:text-graphite-dim focus:border-marker-line focus:outline-none";

export function AuthForm() {
  const [mode, setMode] = useState<Mode>("signin");
  const isSignup = mode === "signup";
  const action = isSignup ? signupAction : loginAction;
  const initialState: AuthActionState = { error: null };
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <>
      {/* Server Actions submit credentials without exposing the HttpOnly
          session token to this client component. */}
      <form action={formAction}>
        <div className={fieldClass}>
          <label className={labelClass} htmlFor="email">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@corpus.dev"
            required
            className={inputClass}
          />
        </div>

        <div className={fieldClass}>
          <label className={labelClass} htmlFor="password">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={isSignup ? "new-password" : "current-password"}
            placeholder="••••••••"
            minLength={8}
            required
            className={inputClass}
          />
        </div>

        {state.error && (
          <p role="alert" className="mb-1 text-[12.5px] leading-[1.5] text-marker">
            {state.error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="mt-2 w-full cursor-pointer rounded-[3px] bg-marker p-3 font-semibold tracking-[0.005em] text-[#171004] transition hover:brightness-[1.08] active:translate-y-px disabled:cursor-wait disabled:opacity-70"
        >
          {pending ? "Please wait..." : isSignup ? "Create account" : "Sign in"}
        </button>
      </form>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
        <p className="text-[13px] text-graphite">
          {isSignup ? "Already have an account? " : "New here? "}
          <button
            type="button"
            onClick={() => setMode(isSignup ? "signin" : "signup")}
            disabled={pending}
            className="cursor-pointer text-bone underline decoration-marker-line underline-offset-[3px] hover:text-marker disabled:cursor-wait disabled:opacity-70"
          >
            {isSignup ? "Sign in" : "Create an account"}
          </button>
        </p>
      </div>
    </>
  );
}
