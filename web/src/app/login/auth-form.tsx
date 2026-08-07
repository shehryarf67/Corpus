"use client";

import Link from "next/link";
import { useState } from "react";

type Mode = "signin" | "signup";

const fieldClass = "mb-[14px]";
const labelClass =
  "mb-[7px] block font-mono text-[10.5px] tracking-[0.13em] uppercase text-graphite-dim";
const inputClass =
  "w-full rounded-[3px] border border-rule-strong bg-chrome px-[13px] py-[11px] text-[14px] text-bone transition-colors duration-150 placeholder:text-graphite-dim focus:border-marker-line focus:outline-none";

export function AuthForm() {
  const [mode, setMode] = useState<Mode>("signin");
  const isSignup = mode === "signup";

  return (
    <>
      <form
        // No auth yet — this only stops the browser's default navigate-on-submit
        // so the page doesn't reload with the fields in the query string.
        onSubmit={(event) => event.preventDefault()}
      >
        {isSignup && (
          <div className={fieldClass}>
            <label className={labelClass} htmlFor="name">
              Name
            </label>
            <input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              placeholder="Shehryar"
              className={inputClass}
            />
          </div>
        )}

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
            // Tells a password manager whether to offer a saved password or
            // generate a new one.
            autoComplete={isSignup ? "new-password" : "current-password"}
            placeholder="••••••••"
            className={inputClass}
          />
        </div>

        <button
          type="submit"
          // #171004 is a near-black brown that sits on the amber fill — dark
          // enough to stay readable without going flat black.
          className="mt-2 w-full cursor-pointer rounded-[3px] bg-marker p-3 font-semibold tracking-[0.005em] text-[#171004] transition hover:brightness-[1.08] active:translate-y-px"
        >
          {isSignup ? "Create account" : "Sign in"}
        </button>
      </form>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
        <p className="text-[13px] text-graphite">
          {isSignup ? "Already have an account? " : "New here? "}
          <button
            type="button"
            onClick={() => setMode(isSignup ? "signin" : "signup")}
            className="cursor-pointer text-bone underline decoration-marker-line underline-offset-[3px] hover:text-marker"
          >
            {isSignup ? "Sign in" : "Create an account"}
          </button>
        </p>

        {/* No auth yet, so this is just a way into the app while building. */}
        <Link
          href="/documents"
          className="cursor-pointer font-mono text-[11.5px] tracking-[0.06em] text-graphite-dim hover:text-graphite"
        >
          skip →
        </Link>
      </div>
    </>
  );
}
