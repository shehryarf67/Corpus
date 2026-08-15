"use client";

import { useRef, useState } from "react";
import { DocumentChat } from "@/components/document-chat";
import { PdfViewerClient } from "@/components/pdf-viewer-client";
import type { QuerySource } from "@/lib/query-stream";
import type { PersistedConversationMessage } from "@/lib/api";

type DocumentWorkspaceClientProps = {
  documentId: string;
  filename: string;
  initialConversationId?: string;
  initialMessages: PersistedConversationMessage[];
};

type PageNavigationRequest = {
  pageNumber: number;
  requestId: number;
  chunkId: string;
  content: string;
};

/** Own the state shared between the sibling PDF and chat panes. */
export function DocumentWorkspaceClient({
  documentId,
  filename,
  initialConversationId,
  initialMessages,
}: DocumentWorkspaceClientProps) {
  const [pageRequest, setPageRequest] =
    useState<PageNavigationRequest | null>(null);
  const nextRequestId = useRef(0);

  function handleCitationSelect(source: QuerySource) {
    // Some extraction failures may leave a source without a page. Keep the
    // citation selectable, but only ask the PDF viewer to scroll when a real
    // page number is available.
    if (source.pageNumber == null) return;

    nextRequestId.current += 1;
    setPageRequest({
      pageNumber: source.pageNumber,
      requestId: nextRequestId.current,
      chunkId: source.chunkId,
      content: source.content,
    });
  }

  return (
    <div className="flex flex-1 flex-col lg:grid lg:min-h-0 lg:grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)]">
      <section
        aria-label="Document"
        className="min-w-0 min-h-[640px] overflow-hidden lg:min-h-0"
      >
        <PdfViewerClient
          documentId={documentId}
          filename={filename}
          targetPage={pageRequest?.pageNumber}
          targetPageRequestId={pageRequest?.requestId}
          targetChunkId={pageRequest?.chunkId}
          targetContent={pageRequest?.content}
        />
      </section>

      <DocumentChat
        documentId={documentId}
        initialConversationId={initialConversationId}
        initialMessages={initialMessages}
        onCitationSelect={handleCitationSelect}
      />
    </div>
  );
}
