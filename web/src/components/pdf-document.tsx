"use client";

import { useEffect, useState, type RefObject } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import {
  matchCitationPassage,
  normalizePageFragments,
  type CitationTextFragment,
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
  pageRefs: RefObject<Map<number, HTMLDivElement>>;
  onLoadSuccess: (numberOfPages: number) => void;
  onLoadError: (error: Error) => void;
  highlightPage?: number | null;
  highlightChunkId?: string;
  highlightContent?: string;
  highlightRequestId?: number;
};

export default function PdfDocument({
  fileUrl,
  zoom,
  pageRefs,
  onLoadSuccess,
  onLoadError,
  highlightPage,
  highlightChunkId,
  highlightContent,
  highlightRequestId,
}: PdfDocumentProps) {
  // PdfDocument needs this count to know how many Page components to create.
  // PdfViewer separately stores the same value for its toolbar and controls.
  const [numberOfPages, setNumberOfPages] = useState(0);
  const [textLayerRevision, setTextLayerRevision] = useState(0);

  function handleDocumentLoad({ numPages }: { numPages: number }) {
    setNumberOfPages(numPages);
    onLoadSuccess(numPages);
  }

  function handleTextLayerRendered(pageNumber: number) {
    // Zooming recreates text-layer spans. Re-run matching when the currently
    // cited page finishes rendering so its highlight is restored.
    if (pageNumber === highlightPage) {
      setTextLayerRevision((current) => current + 1);
    }
  }

  useEffect(() => {
    // Always remove the previous visual match first. Page navigation lives in
    // PdfViewer and has already happened independently of this best-effort step.
    for (const pageElement of pageRefs.current.values()) {
      for (const span of pageElement.querySelectorAll(
        ".corpus-citation-highlight",
      )) {
        span.classList.remove("corpus-citation-highlight");
      }
    }

    if (
      highlightPage == null ||
      !highlightChunkId ||
      !highlightContent
    ) {
      return;
    }

    const pageElement = pageRefs.current.get(highlightPage);
    if (!pageElement) return;

    const spans = Array.from(
      pageElement.querySelectorAll<HTMLSpanElement>(
        ".react-pdf__Page__textContent span",
      ),
    );
    if (spans.length === 0) return;

    let previousTop: number | null = null;
    const fragments: CitationTextFragment[] = spans.map((span, sourceIndex) => {
      const top = span.getBoundingClientRect().top;
      const fragment = {
        text: span.textContent ?? "",
        sourceIndex,
        // A visible top-position change tells us PDF.js moved to another line.
        lineBreakBefore:
          previousTop !== null && Math.abs(top - previousTop) > 2,
      };
      previousTop = top;
      return fragment;
    });

    const normalizedPage = normalizePageFragments(fragments);
    const match = matchCitationPassage(
      highlightContent,
      normalizedPage.text,
    );

    // Ambiguous or weak matches deliberately produce no highlight. The page
    // jump still succeeded because it does not depend on this effect.
    if (!match) return;

    const matchedSpanIndexes = new Set(
      normalizedPage.sourceIndexes.slice(match.start, match.end),
    );

    for (const sourceIndex of matchedSpanIndexes) {
      spans[sourceIndex]?.classList.add("corpus-citation-highlight");
    }

    // Page navigation already provided a reliable fallback. Once matching
    // succeeds, refine that jump by centering the first highlighted span.
    const firstMatchedIndex = matchedSpanIndexes.values().next().value;
    const firstMatchedSpan =
      firstMatchedIndex === undefined ? undefined : spans[firstMatchedIndex];

    if (!firstMatchedSpan) return;

    const frameId = requestAnimationFrame(() => {
      firstMatchedSpan.scrollIntoView({
        behavior: accessibleScrollBehavior(),
        block: "center",
        inline: "nearest",
      });
    });

    return () => cancelAnimationFrame(frameId);
  }, [
    highlightChunkId,
    highlightContent,
    highlightPage,
    highlightRequestId,
    pageRefs,
    textLayerRevision,
  ]);

  return (
    <Document
      file={fileUrl}
      onLoadSuccess={handleDocumentLoad}
      onLoadError={onLoadError}
      loading={<p role="status" aria-live="polite">Loading PDF...</p>}
      error={<p role="alert">The PDF could not be displayed.</p>}
    >
      {Array.from({ length: numberOfPages }, (_, index) => {
        // Array indexes start at 0, while PDF.js page numbers start at 1.
        const pageNumber = index + 1;

        return (
          <div
            key={pageNumber}
            data-page-number={pageNumber}
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
              scale={zoom}
              // Canvas draws the visible page. The transparent text layer sits
              // over it so text remains selectable/searchable and gives future
              // citation highlighting real text spans to target.
              renderTextLayer
              renderAnnotationLayer
              onRenderTextLayerSuccess={() =>
                handleTextLayerRendered(pageNumber)
              }
            />
          </div>
        );
      })}
    </Document>
  );
}
