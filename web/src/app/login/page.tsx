import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AnnotatedDocument } from "@/components/annotated-document";
import { Wordmark } from "@/components/wordmark";
import { getCurrentUser } from "@/lib/auth-api";
import { AuthForm } from "./auth-form";

export const metadata: Metadata = {
  title: "Sign in · Corpus",
};

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/documents");

  return (
    <div className="grid min-h-[100dvh] grid-cols-[56px_1fr]">
      {/* Vertical spine, like the stamp down the edge of a bound paper. */}
      <div className="flex items-center justify-center border-r border-rule bg-chrome">
        <p className="rotate-180 font-mono text-[10.5px] tracking-[0.22em] whitespace-nowrap text-graphite-dim uppercase [writing-mode:vertical-rl]">
          corpus · retrieval-augmented document q&a
        </p>
      </div>

      <div className="flex items-center justify-between gap-[clamp(32px,5vw,80px)] px-[clamp(24px,7vw,110px)] py-12">
        <div className="w-full max-w-[480px] shrink-0">
          <div className="mb-[34px]">
            <Wordmark />
            <h1 className="mt-5 font-serif text-[46px] leading-[1.02] font-semibold tracking-[-0.025em]">
              Ask your documents.
              <br />
              Keep the <em className="text-marker italic">receipts</em>.
            </h1>
            <p className="mt-3.5 max-w-[38ch] font-serif text-[19px] leading-[1.5] text-graphite">
              Every answer points back to the passage it came from.
            </p>
          </div>

          <div className="mt-[30px] mb-8 border-y border-rule py-[18px]">
            <div className="font-mono text-[10.5px] tracking-[0.14em] text-graphite-dim uppercase">
              Abstract
            </div>
            <p className="mt-2.5 font-serif text-[14.5px] leading-[1.66] text-read">
              Corpus indexes your PDFs into structure-aware passages, retrieves
              with combined vector and keyword search, and answers only from
              what it finds. Click any citation to land on the exact sentence in
              the source.
            </p>
          </div>

          <AuthForm />
        </div>

        {/* Needs ~500px of its own before it stops crowding the form, so it
            only appears once there's genuinely room for it. */}
        <AnnotatedDocument className="hidden w-full max-w-[500px] xl:block" />
      </div>
    </div>
  );
}
