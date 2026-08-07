import type { Metadata } from "next";
import Link from "next/link";
import { TopBar } from "@/components/top-bar";
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

function DocumentRow({ document }: { document: MockDocument }) {
  const isReady = document.status === "ready";

  const body = (
    <>
      <StatusDot status={document.status} />
      <div className="min-w-0">
        <div className="truncate font-mono text-[12.5px] text-read">
          {document.filename}
        </div>
        <div className="mt-1 truncate font-mono text-[10.5px] text-graphite-dim">
          {statusLine(document)}
        </div>
      </div>
      <time className="ml-auto shrink-0 self-center font-mono text-[10.5px] text-graphite-dim">
        {document.uploadedAt}
      </time>
    </>
  );

  const shared = "flex w-full items-start gap-3 px-4 py-3.5 text-left";

  // Only a finished document can be opened — until ingestion lands there are
  // no chunks to retrieve against, so the row deliberately isn't a link.
  if (!isReady) {
    return (
      <li className="border-b border-rule last:border-b-0">
        <div className={`${shared} cursor-not-allowed opacity-60`}>{body}</div>
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
