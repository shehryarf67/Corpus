"use client";

import { useEffect } from "react";
import { useIngestionJobPolling } from "@/components/ingestion-job-poller";
import { PagePreview } from "@/components/page-preview";

function statusText(status: string): string {
  if (status === "uploading") return "uploading PDF...";
  if (status === "pending") return "waiting to process...";
  if (status === "parsing") return "preparing document...";
  if (status === "embedding") return "preparing document...";
  if (status === "done") return "finishing...";
  return "processing failed";
}

export function OptimisticDocumentCards({
  realDocumentIds,
}: {
  realDocumentIds: string[];
}) {
  const { optimisticDocuments, reconcileRealDocuments } =
    useIngestionJobPolling();

  useEffect(() => {
    // Once a refreshed Server Component contains the database document, its
    // real card replaces the temporary card instead of rendering a duplicate.
    reconcileRealDocuments(realDocumentIds);
  }, [realDocumentIds, reconcileRealDocuments]);

  const realIds = new Set(realDocumentIds);
  const visibleDocuments = optimisticDocuments.filter(
    (document) => !document.documentId || !realIds.has(document.documentId),
  );

  return (
    <>
      {visibleDocuments.map((document) => (
        <li
          key={document.localId}
          aria-busy="true"
          className="mx-auto w-full max-w-[380px] opacity-60 min-[560px]:max-w-none"
        >
          <div className="relative overflow-hidden rounded-[2px] border border-rule shadow-[0_18px_40px_-28px_rgba(0,0,0,0.95)]">
            <PagePreview seed={document.localId} variant="blank" />
            <div className="absolute inset-0 grid place-items-center">
              <span className="font-mono text-[10.5px] tracking-[0.06em] text-graphite-dim">
                {document.status === "uploading" ? "uploading..." : "processing..."}
              </span>
            </div>
          </div>

          <div className="mt-3.5">
            <h2 className="line-clamp-2 min-h-[42px] font-serif text-[15.5px] leading-[1.35] font-medium text-bone">
              {document.title}
            </h2>
            <div className="mt-1 truncate font-mono text-[10.5px] text-graphite-dim">
              {document.filename}
            </div>
            <div className="mt-2 flex items-center gap-2 font-mono text-[10.5px] text-graphite-dim">
              <span className="h-[5px] w-[5px] animate-pulse rounded-full bg-graphite" />
              {statusText(document.status)}
            </div>
          </div>
        </li>
      ))}
    </>
  );
}
