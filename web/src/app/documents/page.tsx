import type { Metadata } from "next";
import Link from "next/link";
import { PagePreview } from "@/components/page-preview";
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
 * How much this document has actually been used — the signal that tells a
 * library apart from a plain file listing.
 */
function activityLine(document: MockDocument): string {
  if (document.status !== "ready") return `added ${document.uploadedAt}`;

  if (document.questionCount === 0) return "no questions yet";

  const label = document.questionCount === 1 ? "question" : "questions";
  const asked = document.lastAskedAt
    ? ` · last asked ${formatRelativeTime(document.lastAskedAt)}`
    : "";
  return `${document.questionCount} ${label}${asked}`;
}

/**
 * The thumbnail. Non-ready documents get a blank page plus a label, because
 * there genuinely is no first page to show yet — faking one would imply the
 * document had been read when it hasn't.
 */
function Thumbnail({ document }: { document: MockDocument }) {
  const isReady = document.status === "ready";

  return (
    <div className="relative overflow-hidden rounded-[2px] border border-rule shadow-[0_18px_40px_-28px_rgba(0,0,0,0.95)] transition-colors group-hover:border-rule-strong">
      <PagePreview seed={document.id} variant={isReady ? "page" : "blank"} />

      {!isReady && (
        <div className="absolute inset-0 grid place-items-center">
          <span className="font-mono text-[10.5px] tracking-[0.06em] text-graphite-dim">
            {document.status === "indexing" ? "indexing…" : "no preview"}
          </span>
        </div>
      )}
    </div>
  );
}

function CardDetails({ document }: { document: MockDocument }) {
  const isFailed = document.status === "failed";

  return (
    <div className="mt-3.5">
      {/* Reserves two lines so cards in a row stay the same height whether a
          title wraps or not. */}
      <h2 className="line-clamp-2 min-h-[42px] font-serif text-[15.5px] leading-[1.35] font-medium text-bone">
        {document.title}
      </h2>

      <div className="mt-1 truncate font-mono text-[10.5px] text-graphite-dim">
        {document.filename}
      </div>

      <div className="mt-2 flex items-start gap-2">
        <span className="mt-[5px]">
          <StatusDot status={document.status} />
        </span>
        {/* A failure's reason is allowed to wrap rather than truncate — being
            readable is the whole point — and sits brighter than the usual meta
            line because it's asking for attention. */}
        {isFailed && document.error ? (
          <span className="font-mono text-[10.5px] leading-[1.5] text-graphite">
            couldn&rsquo;t be indexed — {document.error}
          </span>
        ) : (
          <span className="truncate font-mono text-[10.5px] leading-[1.5] text-graphite-dim">
            {statusLine(document)}
          </span>
        )}
      </div>

      <div className="mt-1.5 truncate font-mono text-[10.5px] text-graphite-dim">
        {activityLine(document)}
      </div>

      {/* Safe as a real <button> because failed cards aren't wrapped in a
          Link — a button inside an anchor would be invalid markup. */}
      {isFailed && (
        <button
          type="button"
          className="mt-3 cursor-pointer rounded-[3px] border border-rule-strong px-2.5 py-1 font-mono text-[10.5px] text-graphite transition-colors hover:border-marker-line hover:text-bone"
        >
          Retry
        </button>
      )}
    </div>
  );
}

function DocumentCard({ document }: { document: MockDocument }) {
  const isReady = document.status === "ready";

  const body = (
    <>
      <Thumbnail document={document} />
      <CardDetails document={document} />
    </>
  );

  // Only a finished document can be opened — until ingestion lands there are
  // no chunks to retrieve against, so neither of these is a link.
  //
  // Indexing is dimmed because it's transient and there's nothing to act on.
  // A failure deliberately is NOT dimmed: it needs attention and carries a
  // Retry, and fading it out would bury exactly the card you should look at.
  if (!isReady) {
    const stateClass =
      document.status === "indexing" ? "cursor-not-allowed opacity-60" : "";
    return (
      <li>
        <div className={`group block ${stateClass}`}>{body}</div>
      </li>
    );
  }

  return (
    <li>
      <Link href={`/documents/${document.id}`} className="group block">
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
        <main className="mx-auto w-full max-w-[960px] px-6 py-12">
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

          {/* Three across at the widest: with a handful of documents that
              leaves fewer orphaned cards on the last row than four would. */}
          <ul className="grid grid-cols-1 gap-x-6 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
            {documents.map((document) => (
              <DocumentCard key={document.id} document={document} />
            ))}
          </ul>
        </main>
      )}
    </div>
  );
}
