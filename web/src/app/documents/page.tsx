import type { Metadata } from "next";
import Link from "next/link";
import { TopBar } from "@/components/top-bar";
import { formatRelativeTime } from "@/lib/format";
import {
  MOCK_DOCUMENTS,
  type DocumentStatus,
  type MockDocument,
} from "@/lib/mock-documents";

export const metadata: Metadata = {
  title: "Documents · Corpus",
};

/** Amber only ever means "ready" — the same rule the rest of the UI follows. */
function StatusDot({ status }: { status: DocumentStatus }) {
  if (status === "ready") {
    return <span className="h-[5px] w-[5px] shrink-0 rounded-full bg-marker" />;
  }
  if (status === "indexing") {
    return (
      <span className="h-[5px] w-[5px] shrink-0 animate-pulse rounded-full bg-graphite" />
    );
  }
  return (
    <span className="h-[5px] w-[5px] shrink-0 rounded-full border border-graphite-dim" />
  );
}

function statusLine(document: MockDocument) {
  if (document.status === "indexing") return "indexing…";
  if (document.status === "failed") return "couldn't be indexed";
  return `indexed · ${document.chunkCount.toLocaleString("en-US")} chunks · ${document.pageCount} pages`;
}

/**
 * Right-hand column: how much this document has actually been used. It's the
 * signal that tells a library apart from a file listing — which of these have
 * you worked with, and which have you never opened.
 */
function ActivityColumn({ document }: { document: MockDocument }) {
  // A failure is the one row state with something to *do*, so this slot
  // carries the action rather than a date. Safe to use a real <button> here
  // because failed rows aren't wrapped in a Link — a button inside an anchor
  // would be invalid markup.
  if (document.status === "failed") {
    return (
      <div className="flex shrink-0 flex-col items-end gap-2">
        <span className="font-mono text-[10.5px] text-graphite-dim">
          added {document.uploadedAt}
        </span>
        <button
          type="button"
          className="cursor-pointer rounded-[3px] border border-rule-strong px-2.5 py-1 font-mono text-[10.5px] text-graphite transition-colors hover:border-marker-line hover:text-bone"
        >
          Retry
        </button>
      </div>
    );
  }

  // Only a ready document can have been asked anything, so for the others
  // there's no activity to report — just when it arrived.
  if (document.status !== "ready") {
    return (
      <div className="shrink-0 text-right font-mono text-[10.5px] text-graphite-dim">
        added {document.uploadedAt}
      </div>
    );
  }

  const hasBeenAsked = document.questionCount > 0;

  return (
    <div className="shrink-0 text-right font-mono text-[10.5px]">
      <div className={hasBeenAsked ? "text-graphite" : "text-graphite-dim"}>
        {hasBeenAsked
          ? `${document.questionCount} ${document.questionCount === 1 ? "question" : "questions"}`
          : "no questions yet"}
      </div>
      <div className="mt-1 text-graphite-dim">
        {hasBeenAsked && document.lastAskedAt
          ? `last asked ${formatRelativeTime(document.lastAskedAt)}`
          : `added ${document.uploadedAt}`}
      </div>
    </div>
  );
}

function DocumentRow({ document }: { document: MockDocument }) {
  const isReady = document.status === "ready";

  const body = (
    <>
      {/* Nudged down to sit level with the title's optical centre. */}
      <span className="mt-[9px]">
        <StatusDot status={document.status} />
      </span>
      <div className="min-w-0 flex-1">
        {/* The title is the document's real identity; serif matches how the
            same title is set on the page itself in the workspace. */}
        <div className="truncate font-serif text-[15.5px] leading-[1.35] font-medium text-bone">
          {document.title}
        </div>
        <div className="mt-[3px] truncate font-mono text-[10.5px] text-graphite-dim">
          {document.filename}
        </div>
        {/* A failure carries a reason, and it's allowed to wrap rather than
            truncate — the whole point is that it's readable. Brighter than
            the usual meta line too, since it's asking for attention. */}
        {document.status === "failed" && document.error ? (
          <div className="mt-[5px] font-mono text-[10.5px] text-graphite">
            couldn&rsquo;t be indexed — {document.error}
          </div>
        ) : (
          <div className="mt-[5px] truncate font-mono text-[10.5px] text-graphite-dim">
            {statusLine(document)}
          </div>
        )}
      </div>
      <ActivityColumn document={document} />
    </>
  );

  const shared = "flex w-full items-start gap-3 px-4 py-4 text-left";

  // Only a finished document can be opened — until ingestion lands there are
  // no chunks to retrieve against, so neither of these is a link.
  //
  // Indexing is dimmed because it's transient and there's nothing to act on.
  // A failure deliberately is NOT dimmed: it needs attention and carries a
  // Retry, and fading it out would bury exactly the row you should look at.
  if (!isReady) {
    const stateClass =
      document.status === "indexing" ? "cursor-not-allowed opacity-60" : "";
    return (
      <li className="border-b border-rule last:border-b-0">
        <div className={`${shared} ${stateClass}`}>{body}</div>
      </li>
    );
  }

  return (
    <li className="border-b border-rule last:border-b-0">
      <Link
        href={`/documents/${document.id}`}
        className={`${shared} transition-colors hover:bg-raise`}
      >
        {body}
      </Link>
    </li>
  );
}

function UploadButton() {
  return (
    <button
      type="button"
      className="shrink-0 cursor-pointer rounded-[3px] bg-marker px-4 py-2.5 text-[13px] font-semibold text-[#171004] transition hover:brightness-[1.08] active:translate-y-px"
    >
      Upload a PDF
    </button>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      {/* Dashed edge reads as a drop target — drag-and-drop lands here later. */}
      <div className="w-full max-w-[520px] rounded-[4px] border border-dashed border-rule-strong px-8 py-14 text-center">
        <div className="font-mono text-[10.5px] tracking-[0.14em] text-graphite-dim uppercase">
          Library
        </div>
        <h1 className="mt-4 font-serif text-[32px] leading-[1.1] font-semibold tracking-[-0.02em]">
          Add your first document.
        </h1>
        <p className="mx-auto mt-3 max-w-[42ch] font-serif text-[14.5px] leading-[1.66] text-graphite">
          Corpus splits a PDF into structure-aware passages and indexes them, so
          every answer can point back to the page it came from.
        </p>
        <div className="mt-7 flex justify-center">
          <UploadButton />
        </div>
        <p className="mt-4 font-mono text-[10px] tracking-[0.03em] text-graphite-dim">
          pdf only · indexing runs in the background
        </p>
      </div>
    </div>
  );
}

export default async function DocumentsPage(props: PageProps<"/documents">) {
  // Dev affordance while there's no backend: /documents?state=empty renders
  // the first-run screen. Remove once documents come from the API.
  const { state } = await props.searchParams;
  const documents = state === "empty" ? [] : MOCK_DOCUMENTS;

  // Only ready documents contribute passages, so this counts what's actually
  // searchable rather than what's been uploaded.
  const indexedPassages = documents.reduce(
    (total, document) => total + document.chunkCount,
    0,
  );

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <TopBar />

      {documents.length === 0 ? (
        <EmptyState />
      ) : (
        <main className="mx-auto w-full max-w-[880px] px-6 py-12">
          <div className="mb-8 flex items-end justify-between gap-6">
            <div>
              <div className="font-mono text-[10.5px] tracking-[0.14em] text-graphite-dim uppercase">
                Library
              </div>
              <h1 className="mt-2 font-serif text-[30px] leading-[1.1] font-semibold tracking-[-0.02em]">
                Documents
              </h1>
              <p className="mt-2 font-mono text-[10.5px] text-graphite-dim">
                {documents.length}{" "}
                {documents.length === 1 ? "document" : "documents"} ·{" "}
                {indexedPassages.toLocaleString("en-US")} passages indexed
              </p>
            </div>
            {/* Anchored in the header so it stays put as the list grows. */}
            <UploadButton />
          </div>

          <ul className="overflow-hidden rounded-[3px] border border-rule bg-chrome">
            {documents.map((document) => (
              <DocumentRow key={document.id} document={document} />
            ))}
          </ul>
        </main>
      )}
    </div>
  );
}
