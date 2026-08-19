import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocumentWorkspaceClient } from "@/components/document-workspace-client";
import { TopBar, TopBarDivider } from "@/components/top-bar";
import {
  getDocument,
  getDocumentConversation,
  type DocumentResponse,
} from "@/lib/api";
import { ApiError } from "@/lib/api-error";

export const metadata: Metadata = {
  title: "Workspace · Corpus",
};

async function loadDocument(documentId: string): Promise<DocumentResponse> {
  try {
    const response = await getDocument(documentId);
    return response.document;
  } catch (error) {
    // The backend deliberately uses the same 404 for missing and foreign
    // documents, so the frontend must show the same not-found page for both.
    if (error instanceof ApiError && error.status === 404) notFound();

    // Database, network, and other API failures belong to error.tsx. Treating
    // them as 404s would hide a real outage behind a misleading message.
    throw error;
  }
}

export default async function WorkspacePage(
  props: PageProps<"/documents/[id]">,
) {
  const { id } = await props.params;
  const document = await loadDocument(id);
  // The document lookup above handles missing/foreign resources consistently.
  // Once it succeeds, load the newest persisted chat for this owned document.
  const persistedChat = await getDocumentConversation(id);

  return (
    // The viewport itself stays fixed. Each active pane owns its scrolling,
    // preventing mobile users from scrolling through the whole PDF to chat.
    <div className="flex h-[100dvh] min-h-0 flex-col overflow-hidden">
      <TopBar>
        <TopBarDivider />
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="truncate font-mono text-[12.5px] text-read">
            {document.filename}
          </span>
          <span className="hidden font-mono text-[10.5px] whitespace-nowrap text-graphite-dim sm:inline">
            <span className="mr-1.5 inline-block h-[5px] w-[5px] rounded-full bg-marker align-middle" />
            ready · {document.pageCount} pages
          </span>
        </div>
      </TopBar>

      <DocumentWorkspaceClient
        documentId={document.id}
        filename={document.filename}
        initialConversationId={persistedChat.conversation?.id}
        initialMessages={persistedChat.messages}
      />
    </div>
  );
}
