"use client";

import { getJobStatusAction } from "@/app/documents/actions";
import type { DocumentJobStatus } from "@/lib/api";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

type WatchedJob = {
  jobId: string;
  documentId: string;
  startedAt: number;
  status: DocumentJobStatus;
};

type WatchJobInput = Pick<WatchedJob, "jobId" | "documentId" | "status">;

export type InitialWatchedJob = WatchJobInput & {
  startedAt: number;
};

export type OptimisticDocument = {
  localId: string;
  documentId: string | null;
  jobId: string | null;
  title: string;
  filename: string;
  status: "uploading" | DocumentJobStatus;
};

type BeginOptimisticDocumentInput = Pick<
  OptimisticDocument,
  "localId" | "title" | "filename"
>;

type JobPollingContextValue = {
  watchJob: (job: WatchJobInput) => void;
  optimisticDocuments: OptimisticDocument[];
  beginOptimisticDocument: (document: BeginOptimisticDocumentInput) => void;
  acceptOptimisticDocument: (
    localId: string,
    result: WatchJobInput,
  ) => void;
  removeOptimisticDocument: (localId: string) => void;
  reconcileRealDocuments: (documentIds: string[]) => void;
};

const JobPollingContext = createContext<JobPollingContextValue | null>(null);

export function IngestionJobPollingProvider({
  children,
  initialJobs,
}: {
  children: ReactNode;
  initialJobs: InitialWatchedJob[];
}) {
  const router = useRouter();
  const [jobs, setJobs] = useState<WatchedJob[]>(initialJobs);
  const [optimisticDocuments, setOptimisticDocuments] = useState<
    OptimisticDocument[]
  >([]);
  const [notice, setNotice] = useState<string | null>(null);
  const pollInProgress = useRef(false);

  const watchJob = useCallback((job: WatchJobInput) => {
    setNotice(null);
    setJobs((currentJobs) => {
      if (currentJobs.some((currentJob) => currentJob.jobId === job.jobId)) {
        return currentJobs;
      }

      return [...currentJobs, { ...job, startedAt: Date.now() }];
    });
  }, []);

  const beginOptimisticDocument = useCallback(
    (document: BeginOptimisticDocumentInput) => {
      setOptimisticDocuments((currentDocuments) => [
        ...currentDocuments,
        {
          ...document,
          documentId: null,
          jobId: null,
          status: "uploading",
        },
      ]);
    },
    [],
  );

  const acceptOptimisticDocument = useCallback(
    (localId: string, result: WatchJobInput) => {
      setOptimisticDocuments((currentDocuments) =>
        currentDocuments.map((document) =>
          document.localId === localId
            ? {
                ...document,
                documentId: result.documentId,
                jobId: result.jobId,
                status: result.status,
              }
            : document,
        ),
      );
    },
    [],
  );

  const removeOptimisticDocument = useCallback((localId: string) => {
    setOptimisticDocuments((currentDocuments) =>
      currentDocuments.filter((document) => document.localId !== localId),
    );
  }, []);

  const reconcileRealDocuments = useCallback((documentIds: string[]) => {
    const realIds = new Set(documentIds);
    setOptimisticDocuments((currentDocuments) => {
      const nextDocuments = currentDocuments.filter(
        (document) => !document.documentId || !realIds.has(document.documentId),
      );
      return nextDocuments.length === currentDocuments.length
        ? currentDocuments
        : nextDocuments;
    });
  }, []);

  useEffect(() => {
    if (jobs.length === 0) return;

    let disposed = false;

    async function pollJobs() {
      // A slow request should not allow the interval to start a second copy
      // of the same poll before the first one has finished.
      if (pollInProgress.current) return;
      pollInProgress.current = true;

      try {
        const now = Date.now();
        const timedOutIds = new Set(
          jobs
            .filter((job) => now - job.startedAt >= POLL_TIMEOUT_MS)
            .map((job) => job.jobId),
        );

        if (timedOutIds.size > 0) {
          setNotice(
            "Indexing is taking longer than expected. Polling stopped; refresh the library later to check again.",
          );
        }

        const activeJobs = jobs.filter((job) => !timedOutIds.has(job.jobId));
        const results = await Promise.all(
          activeJobs.map(async (watchedJob) => ({
            watchedJob,
            result: await getJobStatusAction(watchedJob.jobId),
          })),
        );

        if (disposed) return;

        const finishedIds = new Set<string>();
        const latestStatuses = new Map<string, DocumentJobStatus>();
        let shouldRefresh = timedOutIds.size > 0;

        for (const { watchedJob, result } of results) {
          if (!result.job) continue;

          latestStatuses.set(watchedJob.jobId, result.job.status);

          if (result.job.status !== watchedJob.status) {
            shouldRefresh = true;
          }

          if (result.job.status === "done" || result.job.status === "failed") {
            finishedIds.add(watchedJob.jobId);
            shouldRefresh = true;

            if (result.job.status === "failed") {
              setNotice(
                result.job.error
                  ? `Indexing failed: ${result.job.error}`
                  : "Indexing failed. Open the document card for details.",
              );
            }
          }
        }

        // Keep a temporary card current if the real document-list refresh has
        // not replaced it yet.
        setOptimisticDocuments((currentDocuments) => {
          let changed = false;
          const nextDocuments = currentDocuments.map((document) => {
            if (!document.jobId) return document;
            const nextStatus = latestStatuses.get(document.jobId);
            if (!nextStatus || nextStatus === document.status) return document;
            changed = true;
            return { ...document, status: nextStatus };
          });
          return changed ? nextDocuments : currentDocuments;
        });

        setJobs((currentJobs) => {
          let changed = false;
          const nextJobs: WatchedJob[] = [];

          for (const job of currentJobs) {
            if (timedOutIds.has(job.jobId) || finishedIds.has(job.jobId)) {
              changed = true;
              continue;
            }

            const nextStatus = latestStatuses.get(job.jobId) ?? job.status;
            if (nextStatus !== job.status) {
              changed = true;
              nextJobs.push({ ...job, status: nextStatus });
            } else {
              // Preserve the same object when nothing changed so React does
              // not restart this polling effect between scheduled intervals.
              nextJobs.push(job);
            }
          }

          return changed ? nextJobs : currentJobs;
        });

        // Status changes and terminal states are loaded from the real backend
        // document response, replacing any status previously shown by the UI.
        if (shouldRefresh) router.refresh();
      } finally {
        pollInProgress.current = false;
      }
    }

    void pollJobs();
    const intervalId = window.setInterval(pollJobs, POLL_INTERVAL_MS);

    // Clear the timer when this provider unmounts or when the watched-job list
    // changes. This prevents polling from leaking into another page.
    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [jobs, router]);

  return (
    <JobPollingContext.Provider
      value={{
        watchJob,
        optimisticDocuments,
        beginOptimisticDocument,
        acceptOptimisticDocument,
        removeOptimisticDocument,
        reconcileRealDocuments,
      }}
    >
      {children}
      {notice && (
        <div
          role="status"
          aria-live="polite"
          className="fixed right-5 bottom-5 z-50 flex max-w-[420px] items-start gap-4 rounded-[4px] border border-rule-strong bg-chrome px-4 py-3 text-[12.5px] leading-[1.5] text-read shadow-[0_20px_55px_rgba(0,0,0,0.55)]"
        >
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss ingestion status"
            className="cursor-pointer text-graphite-dim hover:text-bone"
          >
            x
          </button>
        </div>
      )}
    </JobPollingContext.Provider>
  );
}

export function useIngestionJobPolling(): JobPollingContextValue {
  const context = useContext(JobPollingContext);
  if (!context) {
    throw new Error(
      "useIngestionJobPolling must be used inside IngestionJobPollingProvider",
    );
  }
  return context;
}
