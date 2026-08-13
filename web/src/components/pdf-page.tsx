"use client";

import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

// React-PDF 10.4.1 expects PDF.js 5.4.296. Resolving the worker from this
// workspace's pinned pdfjs-dist package keeps the main library and worker on
// the same version, which PDF.js requires.
//
// React-PDF also requires workerSrc to be configured in the same module that
// renders Document/Page so module execution order cannot overwrite it later.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

type PdfPageProps = {
  fileUrl: string;
  pageNumber: number;
  width?: number;
  onLoadSuccess?: (numberOfPages: number) => void;
  onLoadError?: (error: Error) => void;
};

export default function PdfPage({
  fileUrl,
  pageNumber,
  width,
  onLoadSuccess,
  onLoadError,
}: PdfPageProps) {
  return (
    <Document
      file={fileUrl}
      onLoadSuccess={({ numPages }) => onLoadSuccess?.(numPages)}
      onLoadError={onLoadError}
      loading={<p>Loading PDF...</p>}
      error={<p>The PDF could not be displayed.</p>}
    >
      <Page pageNumber={pageNumber} width={width} />
    </Document>
  );
}
