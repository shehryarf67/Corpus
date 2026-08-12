"use client";

import { retryDocumentAction } from "@/app/documents/actions";
import { useIngestionJobPolling } from "@/components/ingestion-job-poller";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function RetryDocumentButton({ documentId }: { documentId: string }) {
  const router = useRouter();
  const { watchJob } = useIngestionJobPolling();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function retry() {
    setError(null);

    startTransition(async () => {
      const result = await retryDocumentAction(documentId);

      if (result.error || !result.documentId || !result.jobId || !result.status) {
        setError(result.error ?? "The document could not be retried.");
        return;
      }

      // Register the fresh pending job with the same poller used after upload.
      watchJob({
        documentId: result.documentId,
        jobId: result.jobId,
        status: result.status,
      });
      router.refresh();
    });
  }

  return (
    <div className="mt-2.5">
      <button
        type="button"
        onClick={retry}
        disabled={pending}
        className="cursor-pointer rounded-[3px] border border-rule-strong px-3 py-1.5 font-mono text-[10.5px] text-graphite transition hover:border-marker-line hover:text-bone disabled:cursor-wait disabled:opacity-50"
      >
        {pending ? "Retrying..." : "Retry indexing"}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-[11px] leading-[1.4] text-marker">
          {error}
        </p>
      )}
    </div>
  );
}
