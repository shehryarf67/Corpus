"use client";

import { useState, type RefObject } from "react";
import { Document, Page, pdfjs } from "react-pdf";
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
};

export default function PdfDocument({
  fileUrl,
  zoom,
  pageRefs,
  onLoadSuccess,
  onLoadError,
}: PdfDocumentProps) {
  // PdfDocument needs this count to know how many Page components to create.
  // PdfViewer separately stores the same value for its toolbar and controls.
  const [numberOfPages, setNumberOfPages] = useState(0);

  function handleDocumentLoad({ numPages }: { numPages: number }) {
    setNumberOfPages(numPages);
    onLoadSuccess(numPages);
  }

  return (
    <Document
      file={fileUrl}
      onLoadSuccess={handleDocumentLoad}
      onLoadError={onLoadError}
      loading={<p>Loading PDF...</p>}
      error={<p>The PDF could not be displayed.</p>}
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
            <Page pageNumber={pageNumber} scale={zoom} />
          </div>
        );
      })}
    </Document>
  );
}
