"use client"; // Because we're using React state, hooks, refs, and browser interaction

import { useCallback, useEffect, useRef, useState } from "react"
import PdfDocument from "./pdf-document"


type PdfViewerProps = {
    documentId: string
    filename: string
    // A citation will later set this prop to request navigation from outside
    // the viewer. null/undefined means no programmatic navigation is pending.
    targetPage?: number | null
    // Changes on every citation activation, including repeated clicks on a
    // citation for the same page, so the navigation effect runs every time.
    targetPageRequestId?: number
    // Highlighting is an optional enhancement after navigation. The chunk ID
    // identifies the request and content supplies text to match on that page.
    targetChunkId?: string
    targetContent?: string
}

export function PdfViewer(PdfViewerProps: PdfViewerProps) {
    // Set Url for the PDF file to be displayed in the viewer. 
    // This URL points to the Next.js API route that fetches the PDF from Hono.
    const {
        documentId,
        filename,
        targetPage,
        targetPageRequestId,
        targetChunkId,
        targetContent,
    } = PdfViewerProps
    const fileUrl = `/api/documents/${encodeURIComponent(documentId)}/pdf`

    // State to manage the current page, total pages, zoom level, and any errors that occur while loading the PDF.
    const [currentPage, setCurrentPage] = useState(1)
    const [totalPages, setTotalPages] = useState(0)
    const [zoom, setZoom] = useState(1)
    const [error, setError] = useState<string | null>(null)

    // Reference for every container of each page in the PDF. 
    // This allows for scrolling to a specific page when the user navigates through the document.
    const pageRefs = useRef(new Map<number, HTMLDivElement>())

    function handleLoadSuccess(numberOfPages: number) {
        setTotalPages(numberOfPages)
        setCurrentPage(1)
        setError(null)
    }

    function handleCurrentPageChange(pageNumber: number) {
        setCurrentPage(pageNumber)
    }

    function handleLoadError(loadError: Error) {
        console.error("PDF viewer failed to load", loadError)
        setError("The PDF could not be displayed.")
    }

    function zoomIn() {
        setZoom((currentZoom) => Math.min(currentZoom + 0.25, 2))
    }

    function zoomOut() {
        setZoom((currentZoom) => Math.max(currentZoom - 0.25, 0.75))
    }

    const scrollToPage = useCallback((pageNumber: number) => {
        // No page elements exist until React-PDF has successfully loaded.
        if (totalPages === 0) return null

        const safePage = Math.min(Math.max(pageNumber, 1), totalPages)

        pageRefs.current.get(safePage)?.scrollIntoView({
            behavior: "smooth",
            block: "start",
        })

        return safePage
    }, [totalPages])

    function goToPage(pageNumber: number) {
        const safePage = scrollToPage(pageNumber)
        if (safePage == null) return

        // IntersectionObserver will later keep this state synchronized while
        // scrolling. For now, button/programmatic navigation updates it here.
        handleCurrentPageChange(safePage)
    }

    useEffect(() => {
        if (targetPage == null || totalPages === 0) return
        // This effect synchronizes an external prop with the scrollable DOM.
        const safePage = scrollToPage(targetPage)
        if (safePage == null) return

        // Update after the effect's synchronous work so the pager immediately
        // reflects a citation jump. IntersectionObserver will later become the
        // authoritative source for pages reached by manual scrolling.
        const frameId = requestAnimationFrame(() => {
            handleCurrentPageChange(safePage)
        })

        return () => cancelAnimationFrame(frameId)
    }, [scrollToPage, targetPage, targetPageRequestId, totalPages])

    const previousDisabled = totalPages === 0 || currentPage <= 1
    const nextDisabled = totalPages === 0 || currentPage >= totalPages

    return (
        <section className="flex h-full min-h-0 flex-col" aria-label={`PDF viewer for ${filename}`}>
            <div className="flex shrink-0 items-center justify-between gap-4 border-b border-rule bg-chrome px-4 py-2.5">
                <p className="min-w-0 truncate font-mono text-[10.5px] text-graphite-dim">
                    {filename}
                </p>

                <div className="flex shrink-0 items-center gap-2" aria-label="PDF page navigation">
                    <button
                        type="button"
                        onClick={() => goToPage(currentPage - 1)}
                        disabled={previousDisabled}
                        className="cursor-pointer rounded-[3px] border border-rule-strong px-2.5 py-1.5 font-mono text-[10.5px] text-graphite hover:text-bone disabled:cursor-not-allowed disabled:opacity-35"
                    >
                        Previous
                    </button>

                    <span className="min-w-[72px] text-center font-mono text-[10.5px] text-read" aria-live="polite">
                        {totalPages === 0 ? "- / -" : `${currentPage} / ${totalPages}`}
                    </span>

                    <button
                        type="button"
                        onClick={() => goToPage(currentPage + 1)}
                        disabled={nextDisabled}
                        className="cursor-pointer rounded-[3px] border border-rule-strong px-2.5 py-1.5 font-mono text-[10.5px] text-graphite hover:text-bone disabled:cursor-not-allowed disabled:opacity-35"
                    >
                        Next
                    </button>
                </div>

                <div className="flex shrink-0 items-center gap-2" aria-label="PDF zoom controls">
                    <button
                        type="button"
                        onClick={zoomOut}
                        disabled={zoom <= 0.75}
                        aria-label="Zoom out"
                        className="cursor-pointer rounded-[3px] border border-rule-strong px-2.5 py-1.5 font-mono text-[11px] text-graphite hover:text-bone disabled:cursor-not-allowed disabled:opacity-35"
                    >
                        -
                    </button>
                    <span className="min-w-[44px] text-center font-mono text-[10.5px] text-read">
                        {Math.round(zoom * 100)}%
                    </span>
                    <button
                        type="button"
                        onClick={zoomIn}
                        disabled={zoom >= 2}
                        aria-label="Zoom in"
                        className="cursor-pointer rounded-[3px] border border-rule-strong px-2.5 py-1.5 font-mono text-[11px] text-graphite hover:text-bone disabled:cursor-not-allowed disabled:opacity-35"
                    >
                        +
                    </button>
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto bg-void p-5">
                {error ? (
                    <div role="alert" className="grid min-h-[240px] place-items-center text-center font-serif text-[14px] text-graphite">
                        {error}
                    </div>
                ) : (
                    <PdfDocument
                        fileUrl={fileUrl}
                        zoom={zoom}
                        pageRefs={pageRefs}
                        onLoadSuccess={handleLoadSuccess}
                        onLoadError={handleLoadError}
                        highlightPage={targetPage}
                        highlightChunkId={targetChunkId}
                        highlightContent={targetContent}
                        highlightRequestId={targetPageRequestId}
                    />
                )}
            </div>
        </section>
    )
}
