"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";

// PDF.js depends on browser APIs and a Web Worker. This dynamic boundary keeps
// the worker-owning module out of Next's server-rendering pass.
const PdfPageWithoutSsr = dynamic(() => import("./pdf-page"), {
  ssr: false,
  loading: () => <p>Preparing PDF viewer...</p>,
});

export function PdfPageClient(props: ComponentProps<typeof PdfPageWithoutSsr>) {
  return <PdfPageWithoutSsr {...props} />;
}
