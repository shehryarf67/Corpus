import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TopBar, TopBarDivider } from "@/components/top-bar";
import { getDocument, type DocumentResponse } from "@/lib/api";
import { ApiError } from "@/lib/api-error";

export const metadata: Metadata = {
  title: "Workspace · Corpus",
};

async function loadDocument(documentId: string): Promise<DocumentResponse> {
  try {
    const response = await getDocument(documentId);
    return response.document;
  } catch (error) {
    // The backend deliberately uses the same 404 for missing and foreign
    // documents, so the frontend must show the same not-found page for both.
    if (error instanceof ApiError && error.status === 404) notFound();

    // Database, network, and other API failures belong to error.tsx. Treating
    // them as 404s would hide a real outage behind a misleading message.
    throw error;
  }
}

/* ── paper pane ─────────────────────────────────────────────── */

function PaperPane({ document }: { document: DocumentResponse }) {
  return (
    <section
      aria-label="Document"
      className="flex min-h-[420px] items-center justify-center px-6 py-12"
    >
      <div className="w-full max-w-[520px] rounded-[4px] border border-dashed border-rule-strong px-8 py-14 text-center">
        <div className="font-mono text-[10.5px] tracking-[0.14em] text-graphite-dim uppercase">
          Document viewer
        </div>
        <h1 className="mt-4 font-serif text-[30px] leading-[1.1] font-semibold tracking-[-0.02em]">
          PDF viewer coming next.
        </h1>
        <p className="mx-auto mt-3 max-w-[42ch] font-serif text-[14.5px] leading-[1.66] text-graphite">
          The real file is safely stored and indexed. Rendering pages and
          jumping to cited passages will be connected in the viewer phase.
        </p>
        <div className="mt-6 font-mono text-[10.5px] leading-[1.7] text-graphite-dim">
          <div className="truncate text-graphite">{document.filename}</div>
          <div>
            {document.pageCount} {document.pageCount === 1 ? "page" : "pages"}
          </div>
        </div>
      </div>
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
  const document = await loadDocument(id);

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
        <PaperPane document={document} />
        <ChatPane />
      </div>
    </div>
  );
}
