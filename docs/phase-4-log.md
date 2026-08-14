Phase 4: protected PDF access and document viewer
=================================================

Step 1: protected PDF backend endpoint
=======================================

We started GET /documents/:documentId/pdf inside the existing documents router. This is separate from GET /documents/:documentId:

```text
GET /documents/:documentId
-> returns lightweight JSON metadata about the document

GET /documents/:documentId/pdf
-> returns the actual stored PDF bytes
```

The route uses Documents.getByIdForUser(documentId, userId), so authentication comes from documentsRoute.use(requireAuth) and ownership is checked before storage is read. A missing document, foreign document, missing storage key, or ENOENT physical-file error returns the same 404. This avoids revealing whether another user's document exists. Other storage errors are rethrown because permission errors, corruption, and unexpected server failures are 500-level problems, not missing resources.

readPdf() is asynchronous and returns a Node Buffer, so we await it and convert it into Uint8Array before passing it to the web-standard Response constructor:

```text
storage key -> await readPdf() -> Buffer -> Uint8Array -> Response body
```

Why the PDF response needs headers
==================================

The response body is only raw bytes. The bytes do not tell HTTP clients how the server intends them to be handled, so the response adds metadata through HTTP headers.

Content-Type: application/pdf tells the browser that the bytes represent a PDF. Without it, the browser may treat the response as generic binary data, download it, refuse to preview it, or give a future viewer the wrong media type.

Content-Disposition: inline; filename="safe-name.pdf" tells the browser that the PDF may be displayed inside the browser and supplies a safe filename for download/save actions. Without it, a browser may still display the PDF because of Content-Type, but display-versus-download behavior and the suggested filename become browser-dependent. Using attachment instead of inline would normally force a download.

The filename must be sanitized before being inserted into Content-Disposition. Database filenames are user-controlled upload metadata and could contain quotes, slashes, newlines, control characters, or non-ASCII characters that do not safely belong in a raw HTTP header. The current safe-name.pdf value is only a placeholder; replacing it with a sanitized original filename is still part of this endpoint step.

The status code is not a header. status: 200 says the request succeeded, while the two headers describe the successful response body. Similarly, the route returns a JSON 404 response for a genuinely missing resource. We return a 404 response rather than throwing the number 404.

Why this endpoint returns 404
=============================

The PDF endpoint returns 404 when the requested PDF resource is not available to the authenticated user. This intentionally covers several cases:

```text
No document row with that ID
-> 404

The document exists but belongs to another user
-> 404

The document row exists but has no storage key
-> 404

The storage key exists but the physical PDF is missing (ENOENT)
-> 404
```

Missing and foreign documents use the same response because returning 403 for a foreign document would confirm that the guessed document ID exists. Returning the same 404 avoids leaking another user's resource existence.

For a missing physical file, 404 is also accurate because the specific PDF resource requested by the client cannot be found, even if its database metadata still exists.

We do not convert every error into 404:

```text
ENOENT / genuinely missing resource
-> 404 Not Found

Filesystem permission failure
-> server error

Database unavailable
-> server error

Storage corruption or unexpected programming error
-> server error
```

Calling all errors 404 would hide real operational problems and mislead both the user and developer. The route therefore catches only the known missing-file error and rethrows unexpected failures so normal server error handling can treat them as 500-level problems.

Step 2: Next PDF proxy route
============================

Created web/src/app/api/documents/[id]/pdf/route.ts, which gives the browser a same-origin GET /api/documents/:id/pdf URL.

```text
Browser requests the Next PDF URL
-> proxy.ts checks whether a session cookie is present
-> Next reads the HttpOnly cookie server-side
-> Next forwards the cookie to Hono
-> Hono requireAuth validates the session in PostgreSQL
-> Hono checks ownership and reads storage
-> Next passes the PDF response stream back to the browser
```

proxy.ts is only an optimistic cookie-presence check. A present cookie could still be invalid or expired. Hono's requireAuth performs the real authentication, and its ownership-scoped document query decides whether the user may access the PDF.

The Route Handler uses API_BASE_URL rather than NEXT_PUBLIC_API_BASE_URL. API_BASE_URL stays in server code, while NEXT_PUBLIC variables can be exposed to browser JavaScript. The browser therefore knows only the same-origin Next URL and does not need the internal Hono URL.

Passing through Hono responses
==============================

The route returns response.body directly. This is a stream, so Next passes bytes onward as they arrive instead of buffering another complete PDF copy. It preserves the response status and the Content-Type, Content-Disposition, and Content-Length headers needed by the browser.

fetch does not throw merely because Hono returns 401, 404, or 500. Those are completed HTTP responses, so Next passes their status and body through normally.

Handling a failed Hono connection
=================================

fetch throws when Next receives no HTTP response, for example when Hono is stopped, the connection is refused, or the connection breaks. The route catches this network-level failure, records the detailed error in server logs, and returns:

```text
502 Bad Gateway
{ "error": "Document service is currently unavailable" }
```

502 is appropriate because Next is acting as a gateway: Next received the browser request, but its upstream Hono service could not be reached. This is not a 404 because a connection failure does not prove that the document is missing. The internal network error is not sent to the browser because it may reveal implementation details and is not useful to the user.

Step 3: React-PDF and PDF.js compatibility
==========================================

Installed and exactly pinned these packages inside the web workspace:

```text
react-pdf 10.4.1
pdfjs-dist 5.4.296
```

React-PDF 10.4.1 declares pdfjs-dist 5.4.296 as its exact PDF.js dependency. The repository root currently has pdfjs-dist 6.2.108 for other code, but the web viewer must not resolve that incompatible version. PDF.js checks that its main library and worker versions agree; mixing versions can produce a worker/API version mismatch and prevent rendering. Pinning pdfjs-dist directly in web makes the viewer's dependency explicit and stable.

Created pdf-page.tsx as the browser-only module that imports React-PDF's Document, Page, and pdfjs. It configures the worker with:

```text
new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString()
```

This lets the Next bundler emit and reference the worker from the installed local package. It does not depend on an external CDN, does not need a hard-coded public worker URL, and stays aligned with the pinned PDF.js version.

The worker configuration intentionally lives in the same module that renders Document and Page. React-PDF warns that configuring workerSrc in an unrelated setup module can be overwritten because of module execution order.

Created pdf-page-client.tsx as an SSR-disabled dynamic wrapper. PDF.js needs browser APIs and a Web Worker, so the worker-owning component must not run during Next server rendering:

```text
Server-rendered document workspace
-> PdfPageClient dynamic boundary with ssr: false
-> browser loads pdf-page.tsx
-> local PDF.js worker starts
-> React-PDF loads and renders the PDF
```

The text-layer and annotation-layer styles are imported now because later citation selection, text highlighting, and PDF links depend on those React-PDF layers being positioned correctly.

The component is configured but not yet connected to the document workspace. The upcoming viewer step will pass /api/documents/:id/pdf as fileUrl and add page navigation, sizing, loading, errors, and citation highlighting.

Step 4: PDF viewer component structure
======================================

Created three empty component files so the real viewer can be implemented one responsibility at a time:

```text
pdf-viewer.tsx
-> owns the interactive viewer state and controls

pdf-document.tsx
-> configures React-PDF/PDF.js and renders the actual document pages

pdf-viewer-client.tsx
-> provides the Next dynamic import boundary with SSR disabled
```

The viewer UI belongs inside the existing /documents/:id workspace page. The /api/documents/:id/pdf route is not a visual page; it is the protected binary file source consumed by the viewer.

The existing pdf-page.tsx and pdf-page-client.tsx files remain untouched while we build the new structure. Removing or replacing them before the new viewer works would make it harder to compare the simple setup with the completed multi-page viewer.

PdfViewer callbacks and PdfDocument responsibilities
=====================================================

PdfViewer owns currentPage, totalPages, zoom, error, and pageRefs. Its callback functions remain inside PdfViewer because they use that component's state setters and refs. PdfViewer passes those function values down to PdfDocument rather than calling them immediately.

```text
PdfViewer owns totalPages
-> passes handleLoadSuccess downward
-> PdfDocument learns that the PDF has 8 pages
-> PdfDocument calls onLoadSuccess(8)
-> the original PdfViewer function runs setTotalPages(8)
-> PdfViewer re-renders with the updated toolbar state
```

The state itself does not travel back from PdfDocument. The state remains in PdfViewer; the child receives permission, through a callback, to trigger its parent's state update.

PdfDocument is the technical React-PDF rendering layer. It does not repeat backend ingestion, create blocks, chunks, or embeddings, and it does not manually fetch the PDF. It gives fileUrl to React-PDF's Document component, which requests the protected Next PDF endpoint and parses the returned original PDF bytes in the browser.

Step 4a: basic PdfDocument implementation
=========================================

Implemented pdf-document.tsx without IntersectionObserver. It now:

```text
configures the matching local PDF.js worker
-> receives fileUrl, zoom, pageRefs, and callbacks
-> passes fileUrl to React-PDF Document
-> receives numPages after successful parsing
-> stores numPages locally to create Page components
-> calls the parent's onLoadSuccess callback
-> renders every PDF page vertically
-> registers and removes each page container in pageRefs
```

PdfDocument and PdfViewer both keep a page-count value for different reasons. PdfDocument's numberOfPages controls how many Page components are rendered. PdfViewer's totalPages is presentation/controller state used for text such as Page 2 / 8 and navigation limits.

Array.from creates one entry per page. Its index begins at 0, while PDF.js page numbers begin at 1, so pageNumber is index + 1. Each wrapper stores data-page-number and a callback ref. When React mounts an element, it is added to the map; when React unmounts it, the null ref callback removes it. These references will support goToPage now and visible-page observation later.

IntersectionObserver is deliberately deferred. The pages and refs must render correctly first. The next step will observe these existing wrapper elements and call onCurrentPageChange when the most visible page changes.

Step 4b: real pager and viewer toolbar
======================================

The pager belongs in pdf-viewer.tsx because PdfViewer owns currentPage, totalPages, zoom, and goToPage. PdfDocument remains focused on technical PDF loading and page rendering.

The toolbar now contains Previous, current page / total pages, Next, zoom out, zoom percentage, and zoom in. Previous is disabled on page 1, Next is disabled on the final page, and both are disabled before React-PDF reports a page count. The disabled UI prevents ordinary invalid clicks, while goToPage also clamps every requested page between 1 and totalPages to protect calls from other code.

```text
Previous click
-> goToPage(currentPage - 1)

Next click
-> goToPage(currentPage + 1)

Future citation click
-> parent changes targetPage
-> PdfViewer effect calls goToPage(targetPage)
```

goToPage looks up the page's real HTML wrapper in pageRefs and calls scrollIntoView. While IntersectionObserver is still deferred, goToPage also updates currentPage immediately so the pager changes after button and programmatic navigation. Once observation is added, scrolling will also update currentPage automatically.

targetPage is optional because normal viewing does not always involve a citation. It creates a declarative parent-to-viewer API: the future workspace can store the selected citation page and pass it to PdfViewer without reaching into the viewer's internal ref map.

PdfViewer now renders PdfDocument with fileUrl, zoom, pageRefs, and load/error callbacks. The protected URL is still fetched internally by React-PDF. A successful load updates totalPages and clears old errors; a failure logs technical details and shows a safe viewer message.

React effect and navigation state detail
========================================

The first targetPage effect called goToPage, and goToPage synchronously called setCurrentPage. React's lint rules rejected this because an effect should synchronize with an external system, while synchronously deriving more React state inside it can cause cascading renders.

Navigation is now split into two layers:

```text
scrollToPage
-> clamps the page number
-> finds the HTML element
-> scrolls the browser DOM
-> does not change React state

goToPage
-> calls scrollToPage
-> updates currentPage for direct toolbar clicks
```

The targetPage effect calls only scrollToPage because it is synchronizing a prop with the external scroll container. After IntersectionObserver is implemented, the observer callback will see the newly visible citation page and update currentPage. This avoids competing state updates and gives manual scroll, toolbar navigation, and citation navigation one authoritative visible-page signal.

Step 4c: selectable PDF text layer
==================================

React-PDF's Page rendering has multiple layers:

```text
canvas layer
-> draws the visible PDF page

text layer
-> places transparent, selectable HTML text over the canvas

annotation layer
-> supports PDF links and interactive annotations
```

The text-layer and annotation-layer CSS files were already imported in pdf-document.tsx from the earlier React-PDF setup. The Page component now explicitly sets renderTextLayer and renderAnnotationLayer so this behavior is visible in our code rather than relying silently on React-PDF defaults.

The canvas alone looks like the PDF but behaves like an image: users cannot reliably select/search its words, and citation highlighting has no text elements to target. The text layer creates positioned spans aligned over the canvas. Browser selection and find-in-page can operate on those spans, and the later citation feature can identify and style matching spans on the cited page.

The text layer is a frontend rendering feature and is separate from ingestion text extraction. Backend chunks support retrieval and citation metadata; browser text spans support visual selection and highlighting on the original PDF.

Step 4d: browser-only viewer boundary
=====================================

Implemented pdf-viewer-client.tsx as a Client Component that dynamically imports PdfViewer with ssr: false.

The document workspace page is a Server Component, but PDF.js needs browser-only APIs such as window, Canvas, and Web Workers. The wrapper forms this boundary:

```text
Next server renders workspace
-> PdfViewerClient renders its preparation state
-> browser downloads the PdfViewer module
-> PdfViewer imports PdfDocument and PDF.js
-> the local PDF.js worker starts in the browser
```

The dynamic import uses .then(module => module.PdfViewer) because PdfViewer is a named export. If PdfViewer were the module's default export, dynamic(() => import("./pdf-viewer")) would be sufficient.

ComponentProps<typeof PdfViewerWithoutSsr> derives the wrapper's props from the loaded viewer instead of manually duplicating documentId, filename, and targetPage. The spread in <PdfViewerWithoutSsr {...props} /> forwards those values unchanged. This keeps the wrapper synchronized if PdfViewer's props evolve later.

The Preparing PDF viewer message refers to loading the browser-side viewer JavaScript. It is separate from Loading PDF, which appears after the viewer is ready while React-PDF requests and parses the actual file.

This step does not yet replace the workspace's PaperPane placeholder. The next connection step will import PdfViewerClient into /documents/:id/page.tsx and pass the real document ID and filename.

Step 4e: connect the real viewer to the workspace
=================================================

Replaced the temporary PDF viewer coming next content inside the workspace's PaperPane with PdfViewerClient. The Server Component already loads an ownership-scoped DocumentResponse, then passes only the real document ID and filename into the browser-only viewer boundary:

```text
/documents/:id Server Component
-> getDocument(id) through authenticated Hono API
-> PaperPane receives owned document metadata
-> PdfViewerClient receives document.id and document.filename
-> PdfViewer builds /api/documents/:id/pdf
-> protected Next route forwards the session to Hono
-> React-PDF renders the returned original PDF
```

The filename is presentation data for the viewer toolbar. The document ID selects the protected PDF URL. Passing the ID does not bypass security because both the Next request path and Hono route still authenticate the session, and Hono performs the ownership-scoped database lookup before reading storage.

PaperPane remains as the workspace layout boundary rather than being deleted. It gives the PDF side a minimum mobile height, allows it to shrink correctly inside the desktop grid, and hides page overflow outside the viewer's own scroll container. The viewer itself owns internal PDF scrolling.

No targetPage is supplied yet because the workspace chat is still mock presentation. The future real citation click will store a selected page in a shared client workspace component and pass it as targetPage.
