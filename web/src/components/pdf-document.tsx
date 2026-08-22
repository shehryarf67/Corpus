"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import {
  citationFragmentsFromRenderedSpans,
  matchCitationSpanIndexes,
} from "@/lib/citation-matching";
import { accessibleScrollBehavior } from "@/lib/motion";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

// The PDF.js worker performs PDF parsing away from the browser's main UI
// thread. Keep this setup in the same module that renders Document and Page,
// as required by React-PDF, and resolve it from web's pinned pdfjs-dist.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

type PdfDocumentProps = {
  fileUrl: string;
  zoom: number;
  pageWidth?: number;
  pageRefs: RefObject<Map<number, HTMLDivElement>>;
  onLoadSuccess: (numberOfPages: number) => void;
  onLoadError: (error: Error) => void;
  highlightPage?: number | null;
  highlightChunkId?: string;
  highlightContent?: string;
  highlightRequestId?: number;
  onHighlightResult?: (result: "highlighted" | "not-found") => void;
};

function clearCitationHighlight(pageElements: Iterable<HTMLDivElement>) {
  for (const pageElement of pageElements) {
    for (const span of pageElement.querySelectorAll(
      ".corpus-citation-highlight",
    )) {
      span.classList.remove("corpus-citation-highlight");
    }
  }
}

type ApplyHighlightOptions = {
  renderedPage: number;
  targetPage?: number | null;
  chunkId?: string;
  content?: string;
  pageRefs: RefObject<Map<number, HTMLDivElement>>;
  scrollFrameRef: RefObject<number | null>;
  onHighlightResult?: (result: "highlighted" | "not-found") => void;
};

function applyCitationHighlight({
  renderedPage,
  targetPage,
  chunkId,
  content,
  pageRefs,
  scrollFrameRef,
  onHighlightResult,
}: ApplyHighlightOptions) {
  // All pages report text-layer completion. Only the cited page needs work.
  if (renderedPage !== targetPage || !chunkId || !content) return;

  clearCitationHighlight(pageRefs.current.values());

  const pageElement = pageRefs.current.get(renderedPage);
  if (!pageElement) return;

  const spans = Array.from(
    pageElement.querySelectorAll<HTMLSpanElement>(
      ".react-pdf__Page__textContent span",
    ),
  );
  if (spans.length === 0) return;

  const fragments = citationFragmentsFromRenderedSpans(
    spans.map((span) => ({
      text: span.textContent ?? "",
      top: span.getBoundingClientRect().top,
    })),
  );
  const matchedSpanIndexes = matchCitationSpanIndexes(content, fragments);

  // Ambiguous or weak matches deliberately produce no highlight. Page
  // navigation already succeeded independently, so this remains fail-soft.
  if (!matchedSpanIndexes) {
    onHighlightResult?.("not-found");
    return;
  }

  for (const sourceIndex of matchedSpanIndexes) {
    spans[sourceIndex]?.classList.add("corpus-citation-highlight");
  }

  const firstMatchedIndex = matchedSpanIndexes[0];
  const firstMatchedSpan =
    firstMatchedIndex === undefined ? undefined : spans[firstMatchedIndex];
  if (!firstMatchedSpan) return;

  onHighlightResult?.("highlighted");

  if (scrollFrameRef.current !== null) {
    cancelAnimationFrame(scrollFrameRef.current);
  }

  scrollFrameRef.current = requestAnimationFrame(() => {
    firstMatchedSpan.scrollIntoView({
      behavior: accessibleScrollBehavior(),
      block: "center",
      inline: "nearest",
    });
    scrollFrameRef.current = null;
  });
}

export default function PdfDocument({
  fileUrl,
  zoom,
  pageWidth,
  pageRefs,
  onLoadSuccess,
  onLoadError,
  highlightPage,
  highlightChunkId,
  highlightContent,
  highlightRequestId,
  onHighlightResult,
}: PdfDocumentProps) {
  // PdfDocument needs this count to know how many Page components to create.
  // PdfViewer separately stores the same value for its toolbar and controls.
  const [numberOfPages, setNumberOfPages] = useState(0);
  const scrollFrameRef = useRef<number | null>(null);

  function handleDocumentLoad({ numPages }: { numPages: number }) {
    setNumberOfPages(numPages);
    onLoadSuccess(numPages);
  }

  useEffect(() => {
    // A citation click can happen after the text layer already exists, so try
    // immediately. If the layer is still rendering, the Page callback below
    // safely tries again when its spans are ready.
    clearCitationHighlight(pageRefs.current.values());
    if (highlightPage != null) {
      applyCitationHighlight({
        renderedPage: highlightPage,
        targetPage: highlightPage,
        chunkId: highlightChunkId,
        content: highlightContent,
        pageRefs,
        scrollFrameRef,
        onHighlightResult,
      });
    }

    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [
    highlightChunkId,
    highlightContent,
    highlightPage,
    highlightRequestId,
    pageRefs,
    onHighlightResult,
  ]);

  return (
    <Document
      file={fileUrl}
      onLoadSuccess={handleDocumentLoad}
      onLoadError={onLoadError}
      loading={
        <div className="grid min-h-[240px] place-items-center px-5 text-center">
          <p role="status" aria-live="polite" className="font-mono text-[11px] text-graphite-dim">
            Loading document pages...
          </p>
        </div>
      }
      error={<p role="alert">The PDF could not be displayed.</p>}
    >
      {Array.from({ length: numberOfPages }, (_, index) => {
        // Array indexes start at 0, while PDF.js page numbers start at 1.
        const pageNumber = index + 1;

        return (
          <div
            key={pageNumber}
            data-page-number={pageNumber}
            className="mx-auto mb-4 w-fit max-w-none last:mb-0"
            ref={(element) => {
              // Save each rendered page container for navigation and the
              // IntersectionObserver we will add in the next step.
              if (element) {
                pageRefs.current.set(pageNumber, element);
              } else {
                pageRefs.current.delete(pageNumber);
              }
            }}
          >
            <Page
              pageNumber={pageNumber}
              width={pageWidth}
              scale={zoom}
              // Canvas draws the visible page. The transparent text layer sits
              // over it so text remains selectable/searchable and gives future
              // citation highlighting real text spans to target.
              renderTextLayer
              renderAnnotationLayer
              // Apply directly after PDF.js creates the spans. This does not
              // update React state, so rendering the layer cannot trigger an
              // endless render -> state update -> render cycle.
              onRenderTextLayerSuccess={() =>
                applyCitationHighlight({
                  renderedPage: pageNumber,
                  targetPage: highlightPage,
                  chunkId: highlightChunkId,
                  content: highlightContent,
                  pageRefs,
                  scrollFrameRef,
                  onHighlightResult,
                })
              }
            />
          </div>
        );
      })}
    </Document>
  );
}
