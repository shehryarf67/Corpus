import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocumentChat } from "@/components/document-chat";
import { PdfViewerClient } from "@/components/pdf-viewer-client";
import { TopBar, TopBarDivider } from "@/components/top-bar";
import { getDocument, type DocumentResponse } from "@/lib/api";
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

function PaperPane({ document }: { document: DocumentResponse }) {
  return (
    <section
      aria-label="Document"
      className="min-w-0 min-h-[640px] overflow-hidden lg:min-h-0"
    >
      <PdfViewerClient
        documentId={document.id}
        filename={document.filename}
      />
    </section>
  );
}

export default async function WorkspacePage(
  props: PageProps<"/documents/[id]">,
) {
  const { id } = await props.params;
  const document = await loadDocument(id);

  return (
    // Panes scroll internally on desktop; below lg they stack and the page
    // scrolls normally, which avoids needing a mobile pane switcher for now.
    <div className="flex min-h-[100dvh] flex-col lg:h-[100dvh] lg:overflow-hidden">
      <TopBar>
        <TopBarDivider />
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="truncate font-mono text-[12.5px] text-read">
            {document.filename}
          </span>
          <span className="hidden font-mono text-[10.5px] whitespace-nowrap text-graphite-dim sm:inline">
            <span className="mr-1.5 inline-block h-[5px] w-[5px] rounded-full bg-marker align-middle" />
            indexed · {document.chunkCount.toLocaleString("en-US")} chunks ·{" "}
            {document.pageCount} pages
          </span>
        </div>
      </TopBar>

      <div className="flex flex-1 flex-col lg:grid lg:min-h-0 lg:grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)]">
        <PaperPane document={document} />
        <DocumentChat documentId={document.id} />
      </div>
    </div>
  );
}
