"use client"; // Because we're using React state, hooks, refs, and browser interaction

import { useCallback, useEffect, useRef, useState } from "react"
import PdfDocument from "./pdf-document"
import { accessibleScrollBehavior } from "@/lib/motion"
import { changePdfZoom, clampPdfPage } from "@/lib/pdf-viewer-state"


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

type HighlightResult = {
    requestId: number
    result: "highlighted" | "not-found"
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
    const [pageWidth, setPageWidth] = useState<number | undefined>(undefined)
    const [reloadKey, setReloadKey] = useState(0)
    const [highlightResult, setHighlightResult] = useState<HighlightResult | null>(null)
    const [dismissedCitationRequestId, setDismissedCitationRequestId] = useState<number | null>(null)

    // Reference for every container of each page in the PDF. 
    // This allows for scrolling to a specific page when the user navigates through the document.
    const pageRefs = useRef(new Map<number, HTMLDivElement>())
    const scrollRegionRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const scrollRegion = scrollRegionRef.current
        if (!scrollRegion) return

        // Base page width follows the actual pane width. Zoom is applied on
        // top of this value, keeping 100% readable without body overflow.
        function updatePageWidth() {
            const currentRegion = scrollRegionRef.current
            if (!currentRegion) return

            const styles = getComputedStyle(currentRegion)
            const horizontalPadding =
                Number.parseFloat(styles.paddingLeft) +
                Number.parseFloat(styles.paddingRight)
            setPageWidth(Math.max(1, Math.floor(currentRegion.clientWidth - horizontalPadding)))
        }

        updatePageWidth()
        const observer = new ResizeObserver(updatePageWidth)
        observer.observe(scrollRegion)
        return () => observer.disconnect()
    }, [])

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
        setError("This PDF could not be loaded. It may be unavailable or you may no longer have access.")
    }

    function zoomIn() {
        setZoom((currentZoom) => changePdfZoom(currentZoom, "in"))
    }

    function zoomOut() {
        setZoom((currentZoom) => changePdfZoom(currentZoom, "out"))
    }

    const scrollToPage = useCallback((pageNumber: number) => {
        // No page elements exist until React-PDF has successfully loaded.
        if (totalPages === 0) return null

        const safePage = clampPdfPage(pageNumber, totalPages)
        if (safePage == null) return null

        pageRefs.current.get(safePage)?.scrollIntoView({
            behavior: accessibleScrollBehavior(),
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
        // Previous/Next is now the user's active navigation, so an older
        // citation result should not keep describing a page they left.
        setDismissedCitationRequestId(targetPageRequestId ?? 0)
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
    }, [scrollToPage, targetContent, targetPage, targetPageRequestId, totalPages])

    const citationRequestId = targetPageRequestId ?? 0
    const handleHighlightResult = useCallback(
        (result: "highlighted" | "not-found") => {
            if (targetPage == null) return
            setHighlightResult({ requestId: citationRequestId, result })
        },
        [citationRequestId, targetPage],
    )

    const citationFeedback = (() => {
        if (
            targetPage == null ||
            dismissedCitationRequestId === citationRequestId
        ) {
            return null
        }
        if (!targetContent) {
            return `Page ${targetPage} opened. No precise passage was available to highlight.`
        }
        if (highlightResult?.requestId !== citationRequestId) {
            return `Opening page ${targetPage} and locating the supporting passage...`
        }
        return highlightResult.result === "highlighted"
            ? `Page ${targetPage} opened and the supporting passage was highlighted.`
            : `Page ${targetPage} opened. The exact passage could not be highlighted.`
    })()

    const previousDisabled = totalPages === 0 || currentPage <= 1
    const nextDisabled = totalPages === 0 || currentPage >= totalPages

    return (
        <section className="flex h-full min-h-0 w-full flex-col" aria-label={`PDF viewer for ${filename}`}>
            <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 border-b border-rule bg-chrome px-3 py-2.5 sm:flex sm:justify-between sm:gap-4 sm:px-4">
                <p className="col-span-2 min-w-0 truncate font-mono text-[10.5px] text-graphite-dim sm:col-span-1">
                    {filename}
                </p>

                <div className="flex shrink-0 items-center gap-2" role="group" aria-label="PDF page navigation">
                    <button
                        type="button"
                        onClick={() => goToPage(currentPage - 1)}
                        disabled={previousDisabled}
                        aria-label="Previous PDF page"
                        aria-controls="pdf-page-scroll-region"
                        className="grid h-9 min-w-9 cursor-pointer place-items-center rounded-[3px] border border-rule-strong px-2 font-mono text-[10.5px] text-graphite hover:text-bone disabled:cursor-not-allowed disabled:opacity-35 sm:block sm:px-2.5 sm:py-1.5"
                    >
                        <span aria-hidden="true" className="text-base sm:hidden">‹</span>
                        <span className="hidden sm:inline">Previous</span>
                    </button>

                    <span className="min-w-[72px] text-center font-mono text-[10.5px] text-read" role="status" aria-live="polite" aria-atomic="true">
                        {totalPages === 0 ? "- / -" : `${currentPage} / ${totalPages}`}
                    </span>

                    <button
                        type="button"
                        onClick={() => goToPage(currentPage + 1)}
                        disabled={nextDisabled}
                        aria-label="Next PDF page"
                        aria-controls="pdf-page-scroll-region"
                        className="grid h-9 min-w-9 cursor-pointer place-items-center rounded-[3px] border border-rule-strong px-2 font-mono text-[10.5px] text-graphite hover:text-bone disabled:cursor-not-allowed disabled:opacity-35 sm:block sm:px-2.5 sm:py-1.5"
                    >
                        <span aria-hidden="true" className="text-base sm:hidden">›</span>
                        <span className="hidden sm:inline">Next</span>
                    </button>
                </div>

                <div className="flex shrink-0 items-center gap-2" role="group" aria-label="PDF zoom controls">
                    <button
                        type="button"
                        onClick={zoomOut}
                        disabled={zoom <= 0.75}
                        aria-label="Zoom out"
                        className="grid h-9 min-w-9 cursor-pointer place-items-center rounded-[3px] border border-rule-strong px-2 font-mono text-[11px] text-graphite hover:text-bone disabled:cursor-not-allowed disabled:opacity-35"
                    >
                        -
                    </button>
                    <span className="min-w-[44px] text-center font-mono text-[10.5px] text-read">
                        <span className="sr-only">Current zoom: </span>
                        {Math.round(zoom * 100)}%
                    </span>
                    <button
                        type="button"
                        onClick={zoomIn}
                        disabled={zoom >= 2}
                        aria-label="Zoom in"
                        className="grid h-9 min-w-9 cursor-pointer place-items-center rounded-[3px] border border-rule-strong px-2 font-mono text-[11px] text-graphite hover:text-bone disabled:cursor-not-allowed disabled:opacity-35"
                    >
                        +
                    </button>
                </div>
            </div>

            {citationFeedback && (
                <p
                    role="status"
                    aria-live="polite"
                    className="shrink-0 border-b border-rule bg-marker-wash px-3 py-2 font-mono text-[10.5px] leading-[1.45] text-graphite sm:px-4"
                >
                    {citationFeedback}
                </p>
            )}

            <div
                id="pdf-page-scroll-region"
                ref={scrollRegionRef}
                role="region"
                aria-label="PDF pages"
                tabIndex={0}
                className="min-h-0 max-w-full flex-1 overflow-auto bg-void p-2 sm:p-5 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-marker-line"
            >
                {error ? (
                    <div role="alert" className="grid min-h-[240px] place-items-center px-5 text-center">
                        <div>
                            <p className="font-serif text-[14px] leading-6 text-graphite">{error}</p>
                            <button
                                type="button"
                                onClick={() => {
                                    setError(null)
                                    setReloadKey((current) => current + 1)
                                }}
                                className="mt-4 cursor-pointer rounded-[3px] border border-rule-strong px-3 py-2 font-mono text-[10.5px] text-graphite transition-colors hover:border-marker-line hover:text-bone"
                            >
                                Try loading again
                            </button>
                        </div>
                    </div>
                ) : (
                    <PdfDocument
                        key={reloadKey}
                        fileUrl={fileUrl}
                        zoom={zoom}
                        pageWidth={pageWidth}
                        pageRefs={pageRefs}
                        onLoadSuccess={handleLoadSuccess}
                        onLoadError={handleLoadError}
                        highlightPage={targetPage}
                        highlightChunkId={targetChunkId}
                        highlightContent={targetContent}
                        highlightRequestId={targetPageRequestId}
                        onHighlightResult={handleHighlightResult}
                    />
                )}
            </div>
        </section>
    )
}
