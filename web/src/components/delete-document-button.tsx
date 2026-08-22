"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteDocumentAction } from "@/app/documents/actions";

export function DeleteDocumentButton({
  documentId,
  title,
  variant = "button",
}: {
  documentId: string;
  title: string;
  variant?: "button" | "icon";
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function openDialog() {
    setError(null);
    dialogRef.current?.showModal();
  }

  function confirmDeletion() {
    setError(null);

    startTransition(async () => {
      const result = await deleteDocumentAction(documentId);
      if (!result.ok) {
        setError(result.error ?? "The document could not be deleted.");
        return;
      }

      dialogRef.current?.close();
      // Replace prevents Back from reopening a workspace whose document no
      // longer exists; refresh loads the newly revalidated library.
      router.replace("/documents");
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        aria-label={variant === "icon" ? `Delete ${title}` : undefined}
        title={variant === "icon" ? "Delete document" : undefined}
        className={
          variant === "icon"
            ? "grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-[3px] border border-rule-strong bg-void/90 text-graphite shadow-sm transition hover:border-red-400/60 hover:text-red-300 focus-visible:border-red-400/60 focus-visible:text-red-300"
            : "shrink-0 cursor-pointer rounded-[3px] border border-rule-strong px-3 py-2 font-mono text-[10.5px] text-graphite transition-colors hover:border-red-400/50 hover:text-red-300"
        }
      >
        {variant === "icon" ? (
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            className="h-4 w-4"
          >
            <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" />
          </svg>
        ) : (
          "Delete"
        )}
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby="delete-document-title"
        aria-describedby="delete-document-description"
        aria-busy={pending}
        onCancel={(event) => {
          if (pending) event.preventDefault();
        }}
        className="m-auto max-h-[calc(100dvh-24px)] w-[calc(100vw-24px)] max-w-[440px] overflow-y-auto rounded-[4px] border border-rule-strong bg-chrome p-0 text-bone shadow-[0_28px_90px_rgba(0,0,0,0.7)] backdrop:bg-black/70"
      >
        <div className="p-5 sm:p-6">
          <div className="font-mono text-[10px] tracking-[0.14em] text-red-300 uppercase">
            Permanent action
          </div>
          <h2
            id="delete-document-title"
            className="mt-2 font-serif text-[26px] leading-[1.15] font-semibold"
          >
            Delete this document?
          </h2>
          <p
            id="delete-document-description"
            className="mt-3 text-[13.5px] leading-[1.65] text-graphite"
          >
            <span className="break-words text-read">{title}</span> and its
            indexed chunks, jobs, and conversation history will be permanently
            removed.
          </p>

          {error && (
            <p
              role="alert"
              className="mt-4 [overflow-wrap:anywhere] text-[12px] leading-[1.5] text-red-300"
            >
              {error}
            </p>
          )}

          <div className="mt-6 flex flex-col-reverse gap-2.5 min-[420px]:flex-row min-[420px]:justify-end">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              disabled={pending}
              className="w-full cursor-pointer rounded-[3px] border border-rule-strong px-4 py-2.5 text-[13px] text-graphite hover:text-bone disabled:cursor-wait disabled:opacity-50 min-[420px]:w-auto"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmDeletion}
              disabled={pending}
              className="w-full cursor-pointer rounded-[3px] bg-red-400 px-4 py-2.5 text-[13px] font-semibold text-[#190909] transition hover:bg-red-300 disabled:cursor-wait disabled:opacity-60 min-[420px]:w-auto"
            >
              {pending ? "Deleting..." : "Delete permanently"}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
