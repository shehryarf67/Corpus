"use client"; // Needs to be client as it allows for reset() function to reset component

import { TopBar } from "@/components/top-bar";

type ErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function Error({ error, reset }: ErrorProps) {
  console.error("Documents route error:", error);

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <TopBar />

      <main className="flex flex-1 items-center justify-center px-4 py-10 sm:px-6 sm:py-16">
        <div className="w-full max-w-[520px] text-center">
          <div className="font-mono text-[10.5px] tracking-[0.14em] text-graphite-dim uppercase">
            Error
          </div>

          <h1 className="mt-4 font-serif text-[28px] leading-[1.1] font-semibold tracking-[-0.02em] sm:text-[32px]">
            Something went wrong.
          </h1>

          <p className="mx-auto mt-3 max-w-[42ch] font-serif text-[14.5px] leading-[1.66] text-graphite">
            Corpus could not load this part of your document library.
          </p>

          <button
            type="button"
            onClick={reset}
            className="mt-7 w-full cursor-pointer rounded-[3px] bg-marker px-4 py-2.5 text-[13px] font-semibold text-[#171004] transition hover:brightness-[1.08] active:translate-y-px min-[360px]:w-auto"
          >
            Try again
          </button>
        </div>
      </main>
    </div>
  );
}
