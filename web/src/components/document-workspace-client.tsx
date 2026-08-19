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
  content?: string;
};

type WorkspacePanel = "document" | "chat";

/** Own the state shared between the sibling PDF and chat panes. */
export function DocumentWorkspaceClient({
  documentId,
  filename,
  initialConversationId,
  initialMessages,
}: DocumentWorkspaceClientProps) {
  const [pageRequest, setPageRequest] =
    useState<PageNavigationRequest | null>(null);
  // Small screens show one pane at a time. Both panes remain mounted, so
  // switching does not reset PDF zoom/page state or the conversation stream.
  const [activePanel, setActivePanel] = useState<WorkspacePanel>("chat");
  const nextRequestId = useRef(0);

  function handleCitationSelect(source: QuerySource) {
    // A citation always opens the document pane. Page navigation remains
    // fail-soft when extraction could not identify a page number.
    setActivePanel("document");

    // Some extraction failures may leave a source without a page. Keep the
    // citation selectable, but only ask the PDF viewer to scroll when a real
    // page number is available.
    if (source.pageNumber == null) return;

    nextRequestId.current += 1;
    setPageRequest({
      pageNumber: source.pageNumber,
      requestId: nextRequestId.current,
      chunkId: source.chunkId,
      // The full chunk remains available in the source preview, but only the
      // backend-selected supporting passage is precise enough to highlight.
      // Undefined keeps page navigation working without marking unrelated text.
      content: source.highlightText ?? undefined,
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="tablist"
        aria-label="Workspace view"
        className="grid shrink-0 grid-cols-2 border-b border-rule bg-chrome p-1.5 lg:hidden"
      >
        <button
          id="document-workspace-tab"
          type="button"
          role="tab"
          aria-selected={activePanel === "document"}
          aria-controls="document-workspace-panel"
          onClick={() => setActivePanel("document")}
          className="min-h-10 rounded-[3px] px-3 font-mono text-[11px] text-graphite transition-colors hover:text-bone aria-selected:bg-raise aria-selected:text-bone"
        >
          Document
        </button>
        <button
          id="chat-workspace-tab"
          type="button"
          role="tab"
          aria-selected={activePanel === "chat"}
          aria-controls="chat-workspace-panel"
          onClick={() => setActivePanel("chat")}
          className="min-h-10 rounded-[3px] px-3 font-mono text-[11px] text-graphite transition-colors hover:text-bone aria-selected:bg-raise aria-selected:text-bone"
        >
          Chat
        </button>
      </div>

      <div className="min-h-0 flex-1 lg:grid lg:grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)]">
        <section
          id="document-workspace-panel"
          role="tabpanel"
          aria-labelledby="document-workspace-tab"
          className={`${
            activePanel === "document" ? "flex" : "hidden"
          } h-full min-h-0 min-w-0 overflow-hidden lg:flex`}
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

        <div
          id="chat-workspace-panel"
          role="tabpanel"
          aria-labelledby="chat-workspace-tab"
          className={`${
            activePanel === "chat" ? "block" : "hidden"
          } h-full min-h-0 min-w-0 lg:block`}
        >
          <DocumentChat
            documentId={documentId}
            initialConversationId={initialConversationId}
            initialMessages={initialMessages}
            onCitationSelect={handleCitationSelect}
            onOpenDocument={() => setActivePanel("document")}
          />
        </div>
      </div>
    </div>
  );
}
