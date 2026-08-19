"use client";

import { useRouter } from "next/navigation";
import {
  useActionState,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
import { uploadDocumentAction } from "@/app/documents/actions";
import type { UploadDocumentActionState } from "@/app/documents/upload-types";
import { useIngestionJobPolling } from "@/components/ingestion-job-poller";

const MAX_PDF_SIZE_BYTES = 20 * 1024 * 1024;
const PDF_MIME_TYPE = "application/pdf";

const initialState: UploadDocumentActionState = {
  error: null,
  documentId: null,
  jobId: null,
  status: null,
};

function validateFile(file: File | undefined): string | null {
  if (!file) return "Choose a PDF to upload.";
  if (file.size === 0) return "The selected PDF is empty.";
  if (file.type !== PDF_MIME_TYPE || !file.name.toLowerCase().endsWith(".pdf")) {
    return "Choose a PDF file. Other file types are not supported.";
  }
  if (file.size > MAX_PDF_SIZE_BYTES) {
    return "The PDF must be 20 MB or smaller.";
  }
  return null;
}

export function UploadDialog() {
  const router = useRouter();
  const {
    watchJob,
    beginOptimisticDocument,
    acceptOptimisticDocument,
    removeOptimisticDocument,
  } = useIngestionJobPolling();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const optimisticIdRef = useRef<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [hideActionError, setHideActionError] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [state, formAction, pending] = useActionState(
    uploadDocumentAction,
    initialState,
  );

  useEffect(() => {
    const optimisticId = optimisticIdRef.current;

    if (state.error && optimisticId) {
      removeOptimisticDocument(optimisticId);
      optimisticIdRef.current = null;
      return;
    }

    if (
      !optimisticId ||
      !state.documentId ||
      !state.jobId ||
      !state.status
    ) {
      return;
    }

    acceptOptimisticDocument(optimisticId, {
      jobId: state.jobId,
      documentId: state.documentId,
      status: state.status,
    });
    optimisticIdRef.current = null;

    // The provider lives above the changing empty/list page content, so it can
    // keep polling even after this dialog closes or unmounts.
    watchJob({
      jobId: state.jobId,
      documentId: state.documentId,
      status: state.status,
    });

    // The upload is accepted and its pending job now exists. Refresh the
    // Server Component so the real document appears in the library.
    dialogRef.current?.close();
    router.refresh();
  }, [
    acceptOptimisticDocument,
    removeOptimisticDocument,
    router,
    state.documentId,
    state.error,
    state.jobId,
    state.status,
    watchJob,
  ]);

  function chooseFile(file: File | undefined) {
    const error = validateFile(file);
    setClientError(error);
    setHideActionError(true);

    if (error || !file) {
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setSelectedFile(file);
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDragging(false);

    const file = event.dataTransfer.files[0];
    const error = validateFile(file);
    chooseFile(file);
    if (error || !file || !fileInputRef.current) return;

    // A dropped file must also be placed in the real input so the browser
    // includes it in the FormData submitted to the Server Action.
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInputRef.current.files = transfer.files;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    const file = fileInputRef.current?.files?.[0];
    const error = validateFile(file);
    setClientError(error);
    setHideActionError(false);

    // Client validation prevents the request. The Server Action and Hono
    // still repeat validation because browser values can be bypassed.
    if (error) {
      event.preventDefault();
      return;
    }

    // This temporary card appears before the upload request finishes. It has
    // only browser-known data; the backend document replaces it after success.
    if (file && !optimisticIdRef.current) {
      const titleValue = new FormData(event.currentTarget).get("title");
      const suppliedTitle =
        typeof titleValue === "string" ? titleValue.trim() : "";
      const filenameTitle = file.name.replace(/\.pdf$/i, "").trim();
      const localId = window.crypto.randomUUID();

      optimisticIdRef.current = localId;
      beginOptimisticDocument({
        localId,
        filename: file.name,
        title: suppliedTitle || filenameTitle || "Untitled document",
      });
    }
  }

  const displayedError = clientError ?? (!hideActionError ? state.error : null);

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className="w-full shrink-0 cursor-pointer whitespace-nowrap rounded-[3px] bg-marker px-4 py-2.5 text-[13px] font-semibold text-[#171004] transition hover:brightness-[1.08] active:translate-y-px sm:w-auto"
      >
        Upload a PDF
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby="upload-dialog-title"
        className="m-auto max-h-[calc(100dvh-24px)] w-[calc(100vw-24px)] max-w-[520px] overflow-y-auto rounded-[4px] border border-rule-strong bg-chrome p-0 text-bone shadow-[0_28px_90px_rgba(0,0,0,0.7)] backdrop:bg-black/70 sm:max-h-[calc(100dvh-32px)] sm:w-[min(92vw,520px)]"
      >
        <form action={formAction} onSubmit={handleSubmit} className="p-4 sm:p-7">
          <div className="flex min-w-0 items-start justify-between gap-3 sm:gap-5">
            <div className="min-w-0">
              <div className="font-mono text-[10px] tracking-[0.14em] text-graphite-dim uppercase">
                New document
              </div>
              <h2
                id="upload-dialog-title"
                className="mt-2 font-serif text-[27px] leading-[1.1] font-semibold"
              >
                Upload a PDF
              </h2>
            </div>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              disabled={pending}
              aria-label="Close upload dialog"
              className="grid h-10 w-10 shrink-0 cursor-pointer place-items-center text-xl leading-none text-graphite-dim hover:text-bone disabled:cursor-wait disabled:opacity-50"
            >
              ×
            </button>
          </div>

          <label
            htmlFor="document-file"
            onDragEnter={() => setIsDragging(true)}
            onDragLeave={() => setIsDragging(false)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
            className={`mt-5 block cursor-pointer rounded-[4px] border border-dashed px-4 py-7 text-center transition-colors sm:mt-6 sm:px-6 sm:py-10 ${
              isDragging
                ? "border-marker-line bg-marker-wash"
                : "border-rule-strong bg-void hover:border-marker-line"
            }`}
          >
            <input
              ref={fileInputRef}
              id="document-file"
              name="file"
              type="file"
              accept="application/pdf,.pdf"
              required
              disabled={pending}
              onChange={(event) => chooseFile(event.currentTarget.files?.[0])}
              className="sr-only"
            />
            <span className="block break-all font-serif text-[16px] leading-[1.4] text-read sm:text-[17px]">
              {selectedFile ? (
                selectedFile.name
              ) : (
                <>
                  <span className="sm:hidden">Choose or drop a PDF</span>
                  <span className="hidden sm:inline">
                    Drop a PDF here, or choose a file
                  </span>
                </>
              )}
            </span>
            <span className="mt-2 block font-mono text-[10px] text-graphite-dim">
              {selectedFile
                ? `${(selectedFile.size / 1024 / 1024).toFixed(2)} MB`
                : "PDF only · maximum 20 MB"}
            </span>
          </label>

          <div className="mt-5">
            <label
              htmlFor="document-title"
              className="mb-2 block font-mono text-[10px] tracking-[0.12em] text-graphite-dim uppercase"
            >
              Title <span className="normal-case tracking-normal">(optional)</span>
            </label>
            <input
              id="document-title"
              name="title"
              type="text"
              disabled={pending}
              placeholder="Defaults to the PDF filename"
              className="w-full rounded-[3px] border border-rule-strong bg-void px-3 py-2.5 text-[13.5px] text-bone outline-none placeholder:text-graphite-dim focus:border-marker-line disabled:cursor-wait disabled:opacity-60"
            />
          </div>

          <p
            role="alert"
            aria-live="polite"
            className="mt-3 min-h-[20px] text-[12.5px] leading-[1.5] text-marker"
          >
            {displayedError}
          </p>

          <div className="mt-3 flex flex-col-reverse gap-2.5 min-[420px]:flex-row min-[420px]:justify-end">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              disabled={pending}
              className="w-full cursor-pointer rounded-[3px] border border-rule-strong px-4 py-2.5 text-[13px] text-graphite hover:text-bone disabled:cursor-wait disabled:opacity-50 min-[420px]:w-auto"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || !selectedFile}
              className="w-full cursor-pointer rounded-[3px] bg-marker px-4 py-2.5 text-[13px] font-semibold text-[#171004] transition hover:brightness-[1.08] disabled:cursor-not-allowed disabled:opacity-50 min-[420px]:w-auto"
            >
              {pending ? "Uploading..." : "Upload and index"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
