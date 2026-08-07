import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TopBar, TopBarDivider } from "@/components/top-bar";
import { findMockDocument } from "@/lib/mock-documents";

export const metadata: Metadata = {
  title: "Workspace · Corpus",
};

/* ── paper pane ─────────────────────────────────────────────── */

function PaperPage({
  pageNumber,
  stamp,
  children,
}: {
  pageNumber: number;
  stamp?: string;
  children: React.ReactNode;
}) {
  return (
    <article className="relative mx-auto my-[26px] max-w-[640px] rounded-[2px] border border-rule bg-page px-[58px] pt-[54px] pb-[60px] shadow-[0_26px_64px_-34px_rgba(0,0,0,0.95)]">
      {stamp && (
        <span className="absolute top-[54px] -left-px rotate-180 font-mono text-[9.5px] tracking-[0.1em] text-graphite-dim [writing-mode:vertical-rl]">
          {stamp}
        </span>
      )}
      {children}
      <div className="absolute right-0 bottom-[22px] left-0 text-center font-mono text-[10.5px] text-graphite-dim">
        {pageNumber}
      </div>
    </article>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-[13px] font-serif text-[14.5px] leading-[1.74] text-read">
      {children}
    </p>
  );
}

function Heading({
  number,
  children,
}: {
  number: string;
  children: React.ReactNode;
}) {
  return (
    <h2 className="mt-[26px] mb-[9px] font-serif text-[15.5px] font-semibold tracking-[0.005em]">
      <span className="mr-[9px] font-mono text-[12px] text-graphite-dim">
        {number}
      </span>
      {children}
    </h2>
  );
}

function PaperPane() {
  return (
    <section
      aria-label="Document"
      className="grid min-h-0 lg:grid-rows-[minmax(0,1fr)_42px]"
    >
      <div className="px-5 lg:overflow-y-auto">
        <PaperPage pageNumber={1} stamp="joint-pruning-quantization.pdf">
          <h1 className="mb-4 font-serif text-[25px] leading-[1.24] font-semibold tracking-[-0.012em]">
            Joint Pruning and Quantization at Scale
          </h1>
          <p className="mb-[3px] font-serif text-[14px] text-read">
            A. Researcher, B. Collaborator, C. Advisor
          </p>
          <p className="mb-[26px] font-serif text-[13px] text-graphite italic">
            Institute for Efficient Computation
          </p>

          <div className="mb-2 font-mono text-[10px] tracking-[0.16em] text-graphite-dim uppercase">
            Abstract
          </div>
          {/* This paragraph carries the amber margin rule + wash that marks a
              cited passage — the resting look the login animation builds up to. */}
          <div className="relative bg-marker-wash">
            <span className="absolute top-[0.3em] bottom-[0.3em] -left-[26px] w-[2px] bg-marker-line opacity-50" />
            <Body>
              We study whether sparsity and quantization should be optimized
              jointly rather than in sequence. Across seven model scales we find
              the benefit of joint optimization is monotonically decreasing in
              model size, crossing zero between 1.4B and 2.8B parameters.
            </Body>
          </div>

          <Heading number="1">Introduction</Heading>
          <Body>
            Compressing a trained network usually proceeds in stages: prune to a
            target sparsity, then quantize whatever survives. Each stage is well
            understood in isolation, and treating them independently keeps the
            search space small.
          </Body>
          <Body>
            That decomposition is convenient rather than principled. The mask
            chosen during pruning fixes which weights the quantizer must later
            represent, so an early decision constrains a later one without ever
            accounting for it.
          </Body>

          <Heading number="2">Related work</Heading>
          <Body>
            Magnitude pruning with layer-wise calibration remains the strongest
            simple baseline, and post-training quantization methods recover most
            of the accuracy lost at four bits.
          </Body>
        </PaperPage>

        <PaperPage pageNumber={2}>
          <Heading number="3.1">Joint objective</Heading>
          <Body>
            The sparsity mask and the quantization scale are optimized together
            against a shared calibration set, instead of fixing the mask first
            and quantizing whatever remains.
          </Body>
          <Body>
            Because the mask is discrete, it is relaxed during optimization with
            a straight-through estimator and the temperature annealed over five
            hundred steps before a hard mask is recovered.
          </Body>

          <Heading number="3.2">Sequential baseline</Heading>
          <Body>
            The comparison point is deliberately strong: magnitude pruning with
            layer-wise calibration, followed by four-bit quantization over one
            hundred and twenty-eight calibration sequences.
          </Body>
        </PaperPage>
      </div>

      <footer className="hidden items-center justify-center gap-3.5 border-t border-rule bg-chrome lg:flex">
        <button
          type="button"
          className="grid h-6 w-[26px] cursor-pointer place-items-center rounded-[3px] text-graphite transition-colors hover:bg-raise hover:text-bone"
          aria-label="Previous page"
        >
          ‹
        </button>
        <span className="font-mono text-[11.5px] text-graphite">
          <b className="font-medium text-bone">1</b> / 4
        </span>
        <button
          type="button"
          className="grid h-6 w-[26px] cursor-pointer place-items-center rounded-[3px] text-graphite transition-colors hover:bg-raise hover:text-bone"
          aria-label="Next page"
        >
          ›
        </button>
      </footer>
    </section>
  );
}

/* ── chat pane ──────────────────────────────────────────────── */

function SourceChip({
  chunkKey,
  section,
  score,
}: {
  chunkKey: string;
  section: string;
  score: string;
}) {
  return (
    <button
      type="button"
      className="inline-flex cursor-pointer items-center gap-2 rounded-[3px] border border-rule-strong bg-void px-[9px] py-[5px] font-mono text-[10.5px] text-graphite transition-colors hover:border-marker-line hover:bg-marker-wash hover:text-bone"
    >
      <span className="text-marker">{chunkKey}</span>
      <span>{section}</span>
      <span className="text-graphite-dim">{score}</span>
    </button>
  );
}

function ChatPane() {
  return (
    <section
      aria-label="Conversation"
      className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] border-t border-rule bg-chrome lg:border-t-0 lg:border-l"
    >
      <div className="flex flex-col gap-[26px] px-[26px] pt-6 pb-2 lg:overflow-y-auto">
        <div className="max-w-[88%] self-end rounded-[3px] border border-rule-strong bg-raise px-[13px] py-2.5 text-[13.5px] leading-[1.55] text-bone">
          Does joint compression beat sequential at every model scale?
        </div>

        <div className="max-w-full">
          <div className="text-[13.8px] leading-[1.72] text-read">
            No — and that&rsquo;s the paper&rsquo;s main finding.{" "}
            <span className="cite">
              The benefit of joint optimization is monotonically decreasing in
              model scale<sup>c07</sup>
            </span>
            : it peaks at +2.3 points on the 70M model and{" "}
            <span className="cite">
              crosses zero between 1.4B and 2.8B parameters<sup>c07</sup>
            </span>
            , after which sequential is marginally ahead.
          </div>

          <div className="mt-3.5 border-t border-rule pt-3">
            <div className="mb-2 font-mono text-[10.5px] tracking-[0.14em] text-graphite-dim uppercase">
              Sources
            </div>
            <div className="flex flex-wrap gap-1.5">
              <SourceChip
                chunkKey="c07"
                section="§5.2 Scale dependence"
                score="0.96"
              />
              <SourceChip chunkKey="c08" section="Table 1" score="0.89" />
              <SourceChip
                chunkKey="c06"
                section="§5.1 Aggregate"
                score="0.86"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-rule bg-chrome px-[26px] pt-3.5 pb-[18px]">
        <div className="mb-[11px] flex flex-wrap gap-1.5">
          {[
            "How is the joint objective optimized?",
            "What models were used?",
            "What did they not test?",
          ].map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="cursor-pointer rounded-[14px] border border-rule-strong px-2.5 py-1.5 text-[12px] text-graphite transition-colors hover:border-marker-line hover:text-bone"
            >
              {suggestion}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2.5 rounded-[4px] border border-rule-strong bg-void py-1 pr-1 pl-[13px] transition-colors focus-within:border-marker-line">
          <input
            type="text"
            placeholder="Ask about this paper…"
            aria-label="Ask a question"
            className="flex-1 border-0 bg-transparent py-2 text-[13.5px] text-bone outline-none placeholder:text-graphite-dim"
          />
          <button
            type="button"
            aria-label="Send question"
            className="grid h-[30px] w-[30px] cursor-pointer place-items-center rounded-[3px] bg-raise text-graphite transition-colors hover:bg-marker hover:text-[#171004]"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M2.5 7h9M8 3.5L11.5 7 8 10.5"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <p className="mt-[9px] text-center font-mono text-[10px] tracking-[0.03em] text-graphite-dim">
          answers are generated only from indexed passages
        </p>
      </div>
    </section>
  );
}

/* ── page ───────────────────────────────────────────────────── */

export default async function WorkspacePage(
  props: PageProps<"/documents/[id]">,
) {
  const { id } = await props.params;
  const document = findMockDocument(id);

  if (!document) notFound();

  return (
    // Panes scroll internally on desktop; below lg they stack and the page
    // scrolls normally, which avoids needing a mobile pane switcher for now.
    <div className="flex min-h-[100dvh] flex-col lg:h-[100dvh] lg:overflow-hidden">
      <TopBar>
        <TopBarDivider />
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="truncate font-mono text-[12.5px] text-read">
            {document.filename}
          </span>
          <span className="hidden font-mono text-[10.5px] whitespace-nowrap text-graphite-dim sm:inline">
            <span className="mr-1.5 inline-block h-[5px] w-[5px] rounded-full bg-marker align-middle" />
            indexed · {document.chunkCount.toLocaleString("en-US")} chunks ·{" "}
            {document.pageCount} pages
          </span>
        </div>
      </TopBar>

      <div className="flex flex-1 flex-col lg:grid lg:min-h-0 lg:grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)]">
        <PaperPane />
        <ChatPane />
      </div>
    </div>
  );
}
