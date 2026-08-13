"use client"; // Because we're using React state, hooks, refs, and browser interaction

import { useRef, useState } from "react"


type PdfViewerProps = {
    documentId: string
    filename: string
}

export function PdfViewer(PdfViewerProps: PdfViewerProps) {
    // Set Url for the PDF file to be displayed in the viewer. 
    // This URL points to the Next.js API route that fetches the PDF from Hono.
    const { documentId, filename } = PdfViewerProps
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

    function zoomIn() {
        setZoom((currentZoom) => Math.min(currentZoom + 0.25, 2))
    }

    function zoomOut() {
        setZoom((currentZoom) => Math.max(currentZoom - 0.25, 0.75))
    }

    function goToPage(pageNumber: number) {
        const safePage = Math.min(Math.max(pageNumber, 1), totalPages)

        pageRefs.current.get(safePage)?.scrollIntoView({
            behavior: "smooth",
            block: "start",
        })
    }
}