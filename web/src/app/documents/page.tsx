import type { Metadata } from "next";
import Link from "next/link";
import { IngestionJobPollingProvider } from "@/components/ingestion-job-poller";
import { OptimisticDocumentCards } from "@/components/optimistic-document-cards";
import { DocumentThumbnail } from "@/components/document-thumbnail";
import { RetryDocumentButton } from "@/components/retry-document-button";
import { TopBar } from "@/components/top-bar";
import { UploadDialog } from "@/components/upload-dialog";
import {
  getDocuments,
  type DocumentJobStatus,
  type DocumentResponse,
} from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";

export const metadata: Metadata = {
  title: "Documents · Corpus",
};

/** Amber only ever means "ready" — the same rule the rest of the UI follows. */
function StatusDot({ status }: { status: DocumentJobStatus | null }) {
  if (status === "done") {
    return <span className="h-[5px] w-[5px] shrink-0 rounded-full bg-marker" />;
  }
  if (status !== "failed") {
    return (
      <span className="h-[5px] w-[5px] shrink-0 animate-pulse rounded-full bg-graphite" />
    );
  }
  return (
    <span className="h-[5px] w-[5px] shrink-0 rounded-full border border-graphite-dim" />
  );
}

function statusLine(document: DocumentResponse) {
  if (document.status === "failed") return "couldn't be processed";

  // This is still an active backend status, not a failure. The worker may
  // finish later, but automatic browser polling has stopped for this job.
  if (document.processingLongerThanExpected) {
    return "processing is taking longer than expected";
  }

  if (document.status === "pending" || document.status === null) {
    return "waiting to process...";
  }
  if (document.status === "parsing") return "preparing document...";
  if (document.status === "embedding") return "preparing document...";

  return `ready · ${document.pageCount} pages`;
}

/**
 * How much this document has actually been used — the signal that tells a
 * library apart from a plain file listing.
 */
function activityLine(document: DocumentResponse): string {
  // Question activity is not in the real contract yet. Show truthful upload
  // data instead of carrying the mock question counts into production UI.
  return `added ${formatRelativeTime(document.uploadedAt)}`;
}

/**
 * Keep the frame in this Server Component while the Client Component handles
 * image loading failure and swaps in the stable fallback.
 */
function Thumbnail({ document }: { document: DocumentResponse }) {
  return (
    <div className="relative overflow-hidden rounded-[2px] border border-rule shadow-[0_18px_40px_-28px_rgba(0,0,0,0.95)] transition-colors group-hover:border-rule-strong">
      <DocumentThumbnail
        documentId={document.id}
        title={document.title}
        status={document.status}
        thumbnailAvailable={document.thumbnailAvailable}
      />
    </div>
  );
}

function CardDetails({ document }: { document: DocumentResponse }) {
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
            couldn&rsquo;t be processed — {document.error}
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

      {isFailed && <RetryDocumentButton documentId={document.id} />}

    </div>
  );
}

function DocumentCard({ document }: { document: DocumentResponse }) {
  const isReady = document.status === "done";

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
      document.status !== "failed" ? "cursor-not-allowed opacity-60" : "";
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
          Corpus prepares your PDF so answers can point back to the page they
          came from.
        </p>
        <div className="mt-7 flex justify-center">
          <UploadDialog />
        </div>
        <ul className="mx-auto mt-8 grid max-w-[220px] grid-cols-1 text-left empty:hidden">
          <OptimisticDocumentCards realDocumentIds={[]} />
        </ul>
        <p className="mt-4 font-mono text-[10px] tracking-[0.03em] text-graphite-dim">
          pdf only · processing continues in the background
        </p>
      </div>
    </div>
  );
}

export default async function DocumentsPage() {
  // request<T>() forwards the HttpOnly session cookie to Hono, whose route
  // returns only documents owned by the user established from that session.
  const { documents } = await getDocuments();

  const readyDocuments = documents.filter(
    (document) => document.status === "done",
  ).length;
  const realDocumentIds = documents.map((document) => document.id);
  const initialJobs = documents.flatMap((document) => {
    const isActive =
      document.status === "pending" ||
      document.status === "parsing" ||
      document.status === "embedding";

    if (
      !isActive ||
      document.processingLongerThanExpected ||
      !document.jobId ||
      !document.jobCreatedAt ||
      !document.status
    ) {
      return [];
    }

    const parsedStartedAt = Date.parse(document.jobCreatedAt);
    const uploadedAt = Date.parse(document.uploadedAt);

    return [
      {
        jobId: document.jobId,
        documentId: document.id,
        status: document.status,
        startedAt: Number.isFinite(parsedStartedAt) ? parsedStartedAt : uploadedAt,
      },
    ];
  });
  const pollingKey = initialJobs
    .map((job) => `${job.jobId}:${job.status}`)
    .join("|");
  return (
    <IngestionJobPollingProvider key={pollingKey} initialJobs={initialJobs}>
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
                {readyDocuments} ready
              </p>
            </div>
            {/* Anchored in the header so it stays put as the list grows. */}
            <UploadDialog key={documents.length} />
          </div>

          {/* Three across at the widest: with a handful of documents that
              leaves fewer orphaned cards on the last row than four would. */}
          <ul className="grid grid-cols-1 gap-x-6 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
            <OptimisticDocumentCards realDocumentIds={realDocumentIds} />
            {documents.map((document) => (
              <DocumentCard key={document.id} document={document} />
            ))}
          </ul>
          </main>
        )}
      </div>
    </IngestionJobPollingProvider>
  );
}
