"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";

// PDF.js needs browser APIs such as Canvas and Web Workers. Dynamically
// importing the viewer with SSR disabled prevents Next from executing that
// browser-only code during the workspace's server render.
const PdfViewerWithoutSsr = dynamic(
  () => import("./pdf-viewer").then((module) => module.PdfViewer),
  {
    ssr: false,
    loading: () => (
      <div className="grid h-full min-h-[420px] place-items-center">
        <p role="status" aria-live="polite" className="font-mono text-[11px] text-graphite-dim">
          Preparing PDF viewer...
        </p>
      </div>
    ),
  },
);

// Reuse PdfViewer's inferred props so this wrapper stays synchronized when
// fields such as targetPage are added or changed later.
type PdfViewerClientProps = ComponentProps<typeof PdfViewerWithoutSsr>;

export function PdfViewerClient(props: PdfViewerClientProps) {
  return <PdfViewerWithoutSsr {...props} />;
}
