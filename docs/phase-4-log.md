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

Step 4f: browser-facing query stream route
===========================================

Added POST /api/query/stream as a Next Route Handler. The browser will call
this same-origin endpoint instead of knowing Hono's internal API URL.

The route reads the incoming request body and forwards it unchanged to Hono's
existing POST /query/stream endpoint. Hono still owns request validation and
the full query pipeline. Next reads the HttpOnly session cookie on the server
and forwards it so Hono's requireAuth middleware can perform the real database
session check.

```text
browser chat UI
-> Next POST /api/query/stream
-> forward request body and session cookie
-> Hono POST /query/stream
-> requireAuth and query pipeline
-> SSE response returned through Next
-> browser reads events as they arrive
```

The Hono response is named upstream because, from Next's point of view, Hono
is the server farther up the request chain. upstream.body is the live
ReadableStream containing the SSE events.

The route returns upstream.body directly and preserves the SSE content type
and cache-control headers. It must not call upstream.text() or upstream.json(),
because either operation would consume and buffer the complete response before
the browser received it, destroying token-by-token streaming.

Next's proxy.ts can provide a cheap cookie-presence redirect for protected UI,
but it does not prove that a session is valid. The authoritative authentication
check remains Hono's requireAuth middleware, which hashes and checks the token
against an active database session.

If Hono returns an ordinary HTTP error such as 400 or 401 before SSE starts,
Next passes that status and body through. If Next cannot connect to Hono at all,
the route returns 502 because the upstream query service is unavailable.

Step 4g: frontend SSE stream parser
===================================

Added query-stream.ts as the browser helper for POST /api/query/stream. We use
fetch rather than EventSource because the query request needs a POST method and
a JSON body containing documentId, question, and optional conversationId.

The helper calls only the same-origin Next endpoint. It does not know Hono's
URL and does not manually read the HttpOnly cookie. The browser sends that
cookie to Next automatically; the Next route then forwards it to Hono.

```text
streamQuery(input, handlers)
-> POST JSON to /api/query/stream
-> response.body.getReader()
-> read Uint8Array network chunks
-> TextDecoder converts bytes to text
-> buffer joins incomplete pieces
-> split complete SSE blocks on blank lines
-> parse event name and JSON data
-> call the matching UI handler
```

Network chunks are not the same thing as SSE events. A single event can be
split across multiple reader.read() calls, and one read can contain several
events. The buffer keeps the final incomplete piece and joins it with the next
read. Only blocks ending at an SSE blank-line boundary are parsed immediately.

TextDecoder uses stream: true so a multi-byte character split across network
reads is not corrupted. CRLF is normalized to LF, and multiple SSE data lines
are joined before JSON parsing.

The typed handlers match the current Hono contract:

```text
conversation -> provide/store the conversation ID
status       -> generating or finalizing
token        -> append event.text to the visible assistant answer
done         -> replace/finalize with the validated answer and sources
error        -> report the safe streamed error
```

streamQuery resolves with the done result so a caller can use either callbacks
for live UI updates or the final returned value. It rejects normal HTTP errors,
streamed error events, missing response bodies, malformed events, and streams
that close before done. An optional AbortSignal lets a future chat component
cancel reading when needed or when it unmounts.

Step 4h: basic document chat client
===================================

Added DocumentChat as the Client Component that owns interactive chat state.
It currently remains standalone and has not replaced the workspace's mock chat
pane yet.

The component stores messages, the input question, the current conversation ID,
streaming state, and an error. On submit it immediately adds the user's message
and one empty assistant message. It then calls streamQuery with the document ID,
question, and existing conversation ID.

Each token callback finds that assistant message by its stable ID and appends
event.text to its content. This is answer accumulation. It is separate from the
SSE parser's network buffer: the parser buffer reconstructs incomplete protocol
frames, while message content is the text visibly shown to the user.

When done arrives, the component replaces the entire accumulated assistant
content with result.answer and attaches result.sources. The replacement matters
because Hono validates citations after generation, so the authoritative done
answer can differ from the raw text pieces already displayed.

```text
submit question
-> add user message
-> add empty assistant message
-> token: append text to that assistant message
-> token: append more text
-> done: replace all accumulated text with done.answer
-> attach final sources
```

The conversation event saves the server-created conversation ID for the next
question. The form prevents a second simultaneous request, reports stream
errors, and uses AbortController to stop an active reader if the component
unmounts. Citation chips are presentation-only for now; PDF navigation will be
connected in a later step.

Step 4i: connect real chat to the workspace
============================================

Removed the hard-coded example conversation, fake source chips, suggestion
buttons, and inactive question input from the document workspace. The Server
Component now renders DocumentChat with the owned document ID it already loaded.

DocumentChat uses a normal form with a controlled text input and submit button.
Pressing Enter in the single-line input submits through the form automatically.
Empty questions and additional submissions during an active stream are blocked,
and both the input and button show disabled behavior while waiting.

The input now clears only when the done event confirms successful completion.
It is not cleared at request start. This means a failed request leaves the
original question in the input so the user can retry without retyping it.

Step 4j: explicit streaming answer state
=========================================

Each chat message now carries its own status. A user message starts completed,
while the empty assistant placeholder starts as processing. This makes the
submitted user question and a Processing... indicator appear immediately,
before Hono or Ollama returns the first token.

The first token changes the assistant message to streaming and replaces the
processing indicator with its accumulated content. Later tokens append to the
same message. The done event replaces that draft with the validated final
answer, attaches sources, and marks the message done. Technical failure handling
was refined in Step 4l below.

Step 4k: user-controlled stream cancellation
=============================================

The existing AbortController already cancelled the fetch reader when the chat
component unmounted. Added controls for the other two cancellation cases.

Stop generating aborts the active request and preserves any token text already
shown. The assistant message becomes stopped rather than remaining in processing
or pretending to be a completed answer. It also explains that no authoritative,
citation-validated done.answer arrived.

Start over aborts any active request, clears the messages, input, errors, and
conversation ID, and returns the chat to its initial state. Clearing the
conversation ID is important because the next question should create a fresh
backend conversation instead of continuing the previous history.

Step 4l: distinguish RAG refusals from technical failures
=========================================================

The frontend now classifies outcomes using the stream protocol rather than
guessing from the wording of an answer.

A done event is a successful assistant response. This includes an ordinary RAG
refusal such as saying that the indexed document does not contain enough
information. The UI keeps done.answer as a normal assistant message because the
backend intentionally completed and validated that response.

An HTTP failure, network failure, malformed/incomplete stream, or SSE error
event is a technical failure. In this case there is no authoritative done.answer,
so the chat removes the unfinished assistant placeholder and displays the error
separately above the input. The user's question and input remain available for
retry instead of presenting partial generated text as a real answer.

User cancellation remains a third state. It can preserve partial text because
the user deliberately stopped it, but the message is labelled stopped and
explicitly says it was not finalized or citation-validated.

Step 4m: citation source contract for PDF highlighting
======================================================

The existing QuerySource contract already carries the three values required by
the citation viewer:

```text
chunkId    -> stable identity for the cited chunk
pageNumber -> which rendered PDF page to open
content    -> passage text to locate in that page's text layer
```

It also carries label, documentId, and similarity because those are useful for
citation display, ownership/context, and diagnostics. They are metadata rather
than PDF coordinates.

The frontend does not use char_start or char_end for highlighting. Those offsets
describe positions in our extracted and normalized document text, not reliable
positions inside React-PDF's browser text spans. PDF extraction can alter spaces,
line breaks, ligatures, columns, and fragment boundaries, so the offsets do not
map safely back onto the visual page.

The planned highlighting flow is therefore:

```text
click citation
-> identify source by chunkId
-> navigate to pageNumber
-> normalize source.content and page text-layer text
-> find the best matching passage
-> style the matching text-layer spans
```

No functional code change was required for this step because QuerySource already
has this shape and the Phase 4 frontend contains no character-offset dependency.

Step 4n: accessible citation controls
======================================

Final sources already appeared underneath each completed assistant answer, but
they were non-interactive span elements. They are now native buttons displaying
the backend citation label and page number, for example S1 · Page 3.

Native buttons are keyboard focusable and activate with Enter or Space without
custom keyboard handlers. Each button also has an aria-label that announces its
source label and page, visible focus styling, and aria-pressed styling for the
currently selected citation.

DocumentChat now exposes an optional onCitationSelect(source) callback. Selecting
a citation updates its local selected state immediately. The upcoming shared
workspace client can use the callback to pass source.pageNumber and source.content
to the PDF viewer for navigation and text-layer highlighting. Keeping this as a
callback avoids putting PDF behavior inside the chat component.

Step 4o: citation page navigation
=================================

Added DocumentWorkspaceClient as the shared Client Component above the PDF and
chat panes. The Next page remains a Server Component responsible for loading
the owned document metadata. It passes serializable documentId and filename
values into this client workspace, which owns interaction state between panes.

When a citation button is activated, DocumentChat calls onCitationSelect with
the complete QuerySource. DocumentWorkspaceClient checks pageNumber and creates
a page navigation request. The request contains both the page number and an
increasing request ID. The ID ensures clicking the same citation/page twice can
trigger scrolling twice even though the page number itself has not changed.

```text
citation button
-> DocumentChat.selectCitation(source)
-> DocumentWorkspaceClient.handleCitationSelect(source)
-> set { pageNumber, requestId }
-> PdfViewer receives targetPage and targetPageRequestId
-> navigation effect calls scrollToPage(targetPage)
-> pageRefs finds that rendered page container
-> scrollIntoView moves the PDF pane to the page
```

PdfDocument populated pageRefs while rendering each React-PDF Page. The map key
is the one-based PDF page number and the value is its real wrapper div. PdfViewer
clamps an incoming page to the valid 1..totalPages range before looking it up.
After requesting the scroll, it updates currentPage on the next animation frame
so the pager reflects the citation jump. Manual-scroll tracking still belongs to
the later IntersectionObserver step.

This navigation path uses only source.pageNumber. It does not wait for, call, or
depend on passage text matching. Future highlighting will separately use
source.content after the page jump, so a failed highlight cannot prevent the
citation from opening the correct page.

Detailed citation navigation revision notes
---------------------------------------------

Before this change, PdfViewerClient and DocumentChat were sibling components
rendered directly by the Server Component page. The chat knew which citation
was clicked, while the viewer owned page scrolling. Siblings cannot directly
share local React state, and the Server Component cannot hold interactive
useState state or receive a browser click callback.

DocumentWorkspaceClient solves this by becoming the nearest shared Client
Component parent:

```text
WorkspacePage (Server Component)
-> loads owned document metadata
-> passes documentId and filename
-> DocumentWorkspaceClient (shared browser state)
   -> PdfViewerClient
   -> DocumentChat
```

The server page still performs initial data loading. It passes only serializable
strings across the server/client boundary. Interactive citation state belongs
inside DocumentWorkspaceClient because both child panes need it.

DocumentChat's source button calls selectCitation(source). That function first
stores source.chunkId in selectedCitationId, which updates aria-pressed and the
button's selected styling. It then invokes the optional onCitationSelect callback
with the complete QuerySource. DocumentChat does not import PdfViewer or perform
DOM scrolling because those responsibilities belong to the viewer.

DocumentWorkspaceClient supplies handleCitationSelect as that callback. It
checks source.pageNumber before creating a request. A null page keeps the source
button usable and selected but cannot produce a page jump. A valid page creates:

```text
{
  pageNumber: source.pageNumber,
  requestId: an increasing number
}
```

React effects usually rerun when a dependency value changes. If the state held
only pageNumber, clicking Page 3 again while Page 3 was still the target would
set the same value and might not rerun navigation. requestId changes for every
activation, so targetPageRequestId makes every click a distinct request.

PdfViewerClient is still the browser-only dynamic import boundary for PDF.js.
Its ComponentProps-based prop forwarding automatically passes targetPage and
targetPageRequestId through to PdfViewer without duplicating the prop contract.

PdfDocument creates one wrapper div for each React-PDF Page. Its callback ref
adds that real DOM element to pageRefs when mounted and removes it when unmounted:

```text
pageRefs.current
1 -> page 1 wrapper div
2 -> page 2 wrapper div
3 -> page 3 wrapper div
```

When targetPage or targetPageRequestId changes, PdfViewer's effect calls
scrollToPage. The helper first waits until totalPages is known, clamps the
requested value into 1 through totalPages, retrieves the wrapper from pageRefs,
and calls scrollIntoView with smooth behavior and block start. If a citation is
clicked while the PDF is still loading, the totalPages dependency changes after
load and gives the effect another opportunity to perform the pending jump.

The effect schedules currentPage on requestAnimationFrame after requesting the
DOM scroll. This keeps the pager consistent with citation navigation without a
synchronous state update inside the effect. The future IntersectionObserver is
still needed to update currentPage when the user scrolls manually.

Navigation and highlighting deliberately form separate layers:

```text
reliable base action:
source.pageNumber -> find page ref -> scroll page

optional enhancement later:
source.content -> normalize text -> find text-layer match -> highlight spans
```

The base action contains no content matching and no char offsets. Therefore a
spacing, ligature, extraction, or text-layer matching failure can prevent only
the visual highlight; it cannot prevent the citation from opening its page.

Frontend revision map for everything implemented today
=======================================================

This section reorganizes today's frontend work by runtime flow and names the
specific files and functions involved. The chronological entries above explain
when each decision was made. This section explains how the finished pieces now
work together.

1. Protected PDF request from browser to storage
------------------------------------------------

Main files:

```text
web/src/app/api/documents/[id]/pdf/route.ts
server/src/routes/documents.ts
server/src/lib/storage.ts
```

The browser requests the same-origin URL /api/documents/:id/pdf. Next recognizes
the folder and route.ts automatically and runs its exported GET() function on
the Next server. The browser never imports or executes this function directly.

GET() awaits params to read id, reads the private API_BASE_URL, and uses
cookies() from next/headers to serialize the incoming HttpOnly session cookie.
It calls fetch() against Hono's /documents/:id/pdf route and forwards that
cookie. This Next route is a proxy and not the authoritative auth check.

Hono's documents router runs requireAuth, looks up the document with both its ID
and the authenticated user ID, checks storage_key, and calls readPdf(). Missing,
foreign, and physically missing PDFs all return 404 so ownership cannot be
discovered. A successful response contains PDF bytes with application/pdf and
inline Content-Disposition headers.

Back in Next, GET() copies the PDF response status and useful headers, then
returns response.body directly. It does not create another buffered PDF copy.
If fetch cannot connect to Hono at all, the catch block returns 502. Normal Hono
responses such as 401 or 404 do not throw from fetch and pass through normally.

```text
React-PDF
-> GET /api/documents/:id/pdf
-> Next GET()
-> forward cookie to Hono
-> requireAuth and ownership query
-> readPdf(storage_key)
-> stream PDF bytes back through Next
```

2. React-PDF browser boundary and worker setup
----------------------------------------------

Main files:

```text
web/src/components/pdf-viewer-client.tsx
web/src/components/pdf-viewer.tsx
web/src/components/pdf-document.tsx
```

PdfViewerClient is the browser-only boundary. PdfViewerWithoutSsr uses Next's
dynamic() with ssr: false because PDF.js needs browser APIs such as Canvas,
window, and Web Workers. The workspace can remain server-rendered without Next
trying to execute PDF.js on the server.

The dynamic import uses .then(module => module.PdfViewer) because PdfViewer is a
named export. PdfViewerClient uses ComponentProps to derive its props from the
loaded component and forwards them with {...props}. New viewer props therefore
do not need to be manually duplicated in the wrapper.

PdfDocument imports Document, Page, and pdfjs from react-pdf. It configures
GlobalWorkerOptions.workerSrc in the same browser module that renders React-PDF.
The web workspace has its own pinned pdfjs-dist version so React-PDF and its
worker execute matching code.

3. PDF loading, page rendering, and text layers
-----------------------------------------------

PdfViewer builds the protected file URL from documentId:

```text
/api/documents/encoded-document-id/pdf
```

It passes that URL into PdfDocument. React-PDF's Document component fetches and
parses the file. PdfDocument.handleDocumentLoad() receives numPages, stores it
locally for rendering, and calls PdfViewer's handleLoadSuccess() callback so the
parent can update toolbar state.

PdfDocument creates one Page component per page using Array.from(). PDF pages
are one-based, so index 0 becomes pageNumber 1. Each Page is wrapped in a div
with data-page-number and a callback ref. The callback stores mounted wrapper
elements in pageRefs and deletes them when they unmount.

Each Page renders three useful layers:

```text
canvas layer     -> visible PDF page
text layer       -> selectable positioned text spans
annotation layer -> links and PDF annotations
```

TextLayer.css and AnnotationLayer.css provide the positioning required by those
layers. The backend extraction text and browser text layer are different things.
Backend text powers RAG. Browser text spans power selection and later visual
highlighting.

4. PDF viewer state, pager, zoom, and page refs
-----------------------------------------------

PdfViewer owns currentPage, totalPages, zoom, and error state. Its main helpers
are:

```text
handleLoadSuccess()       -> save total pages and clear load errors
handleCurrentPageChange() -> update the toolbar page number
handleLoadError()         -> show a safe viewer error
zoomIn() and zoomOut()    -> clamp zoom between 75 and 200 percent
scrollToPage()            -> clamp page, find its ref, call scrollIntoView
goToPage()                -> toolbar navigation plus current-page update
```

Previous and Next call goToPage(). Buttons are disabled before the PDF loads and
at the first or last page so invalid navigation cannot be requested. pageRefs is
a useRef map because changing DOM references should not itself rerender React.

Manual scrolling does not yet update currentPage. That still needs the planned
IntersectionObserver. Toolbar clicks and citation jumps do update the pager.

5. Browser-facing query streaming proxy
----------------------------------------

Main file:

```text
web/src/app/api/query/stream/route.ts
```

The browser POSTs JSON to /api/query/stream. Next automatically runs the exported
POST() Route Handler on its server. POST() reads the request body, private
API_BASE_URL, and HttpOnly cookies. It forwards the body and Cookie header to
Hono's existing POST /query/stream endpoint.

The Hono fetch result is named upstream because Hono is farther up the chain
from Next's point of view. upstream.body is a ReadableStream. POST() returns
that body directly with SSE headers. Calling upstream.text() or json() would
consume the complete stream and make the browser wait until generation ended.

```text
browser POST
-> Next POST()
-> Hono requireAuth
-> retrieval and answer generation
-> Hono SSE events
-> Next returns upstream.body
-> browser receives events live
```

The browser never knows API_BASE_URL. Next's proxy.ts may cheaply check that a
cookie exists for protected UI navigation, but Hono requireAuth remains the real
session validation.

6. SSE network decoding and frame parsing
-----------------------------------------

Main file:

```text
web/src/lib/query-stream.ts
```

streamQuery() performs the browser fetch because fetch supports POST plus a JSON
body. EventSource was not used because it does not fit this POST request flow.
streamQuery() checks response.ok and response.body before calling
response.body.getReader().

reader.read() returns Uint8Array network chunks. TextDecoder converts those
bytes to text with stream: true so a multi-byte character split across reads is
not corrupted. The local buffer is a protocol buffer, not an answer buffer.

Network chunks and SSE frames do not have matching boundaries. One frame can be
split across reads, and one read can contain multiple frames. streamQuery()
appends decoded text to buffer, normalizes CRLF, splits complete frames on blank
lines, and keeps the final incomplete piece for the next read.

parseSseEvent() reads event: and data: lines from one complete frame. It ignores
SSE comments, joins multiple data lines, parses the JSON, and combines the event
name with its data. dispatchEvent() routes the typed result to the matching
callback:

```text
conversation -> onConversation(conversationId)
status       -> onStatus(status)
token        -> onToken(text)
done         -> onDone(final result)
error        -> onError(message), then reject
```

streamQuery() resolves only after done and returns QueryStreamResult. It rejects
HTTP failures, network failures, stream error events, malformed data, missing
bodies, and a stream that closes without done. Its optional AbortSignal lets the
chat terminate reader.read() and the underlying fetch.

7. Chat submission and live answer state
----------------------------------------

Main file:

```text
web/src/components/document-chat.tsx
```

DocumentChat is a Client Component because it owns input, messages, streaming,
errors, conversation state, refs, click handlers, and form submission.
handleSubmit() prevents the browser's normal form navigation, trims the input,
and refuses empty or simultaneous submissions.

It creates a completed user ChatMessage and an empty processing assistant
ChatMessage with stable IDs from createMessageId(). Both messages are inserted
immediately, so the question and Processing... appear before the first token.

handleSubmit() creates an AbortController and calls streamQuery(). The callback
flow is:

```text
onConversation -> save ID for follow-up questions
onToken        -> find assistant by ID, append text, mark streaming
onDone         -> replace draft with done.answer, attach sources, mark done
onError        -> store the safe error message
```

The visible assistant content is the answer buffer. It is separate from the SSE
frame buffer in query-stream.ts. Functional setMessages(current => ...) updates
are used because tokens arrive asynchronously and every append must use the
latest message state.

done.answer replaces token concatenation because backend citation validation can
change the final result. The input clears only after done. If the request fails,
the question remains available for retry.

8. Processing, refusal, failure, and cancellation states
--------------------------------------------------------

Assistant messages move through explicit states:

```text
processing -> streaming -> done
                     or -> stopped
```

A done event is always treated as a normal assistant response. This includes a
grounded RAG refusal such as saying the document does not contain the answer. We
do not guess whether an answer is an error by reading its wording.

Technical failures are different. A failed fetch, bad HTTP response, malformed
stream, incomplete stream, or SSE error means no authoritative done.answer was
received. handleSubmit() removes that assistant placeholder and shows the error
separately. This prevents a partial model draft from looking completed.

stopActiveStream() aborts the current controller. The catch block recognizes an
AbortError, preserves any partial content, and marks the message stopped with a
warning that it was not finalized or citation-validated.

startOver() aborts active work and clears messages, conversationId, question,
error, citation selection, and streaming state. Clearing conversationId makes
the next question create a fresh backend conversation. The useEffect cleanup
also aborts when DocumentChat unmounts so an abandoned request cannot update it.

9. Accessible citation rendering
---------------------------------

Final sources come from QueryStreamResult and are attached only during onDone.
DocumentChat renders them below the authoritative assistant answer. Each source
button displays source.label and source.pageNumber.

The controls are native button elements instead of clickable spans. This gives
keyboard focus plus Enter and Space activation automatically. aria-label tells
assistive technology the source and page. aria-pressed and
selectedCitationId show which citation is currently selected. Focus-visible
styles make keyboard position visible.

selectCitation() updates selectedCitationId and calls the optional
onCitationSelect(source) callback. The chat owns citation presentation but does
not import PDF logic.

10. Shared workspace and citation page jumps
--------------------------------------------

Main files:

```text
web/src/app/documents/[id]/page.tsx
web/src/components/document-workspace-client.tsx
web/src/components/document-chat.tsx
web/src/components/pdf-viewer-client.tsx
web/src/components/pdf-viewer.tsx
web/src/components/pdf-document.tsx
```

WorkspacePage remains a Server Component. loadDocument() fetches the
ownership-scoped document response and maps backend 404 to notFound(). The page
passes documentId and filename into DocumentWorkspaceClient.

DocumentWorkspaceClient owns PageNavigationRequest because it is the nearest
Client Component parent shared by chat and viewer. handleCitationSelect() reads
source.pageNumber and ignores navigation when it is null. For a valid page it
increments nextRequestId and stores pageNumber plus requestId.

PdfViewer receives targetPage and targetPageRequestId. Its useEffect depends on
both values and totalPages. It calls scrollToPage(), which retrieves the correct
wrapper from pageRefs and smoothly scrolls it into view. requestId makes repeated
clicks on the same page distinct. totalPages lets a pending request retry after
the PDF finishes loading.

The page jump then schedules handleCurrentPageChange() on the next animation
frame so the toolbar reflects the cited page.

The complete current frontend flow is:

```text
question form
-> DocumentChat.handleSubmit()
-> streamQuery()
-> Next POST /api/query/stream
-> Hono query pipeline and SSE
-> token callbacks build visible answer
-> done replaces answer and attaches sources
-> citation button calls selectCitation()
-> DocumentWorkspaceClient.handleCitationSelect()
-> PdfViewer navigation effect
-> scrollToPage()
-> pageRefs lookup
-> scrollIntoView()
```

Highlighting is not involved in this chain. The page jump depends only on
pageNumber. The later enhancement can independently use content to match PDF
text-layer spans. A highlighting failure will therefore not break navigation.

11. Citation text normalization and passage matching
----------------------------------------------------

Main files:

```text
web/src/lib/citation-matching.ts
web/src/components/document-workspace-client.tsx
web/src/components/pdf-viewer.tsx
web/src/components/pdf-document.tsx
web/src/app/globals.css
```

The backend answer cites QuerySource objects. source.content is the extracted
chunk that supported the answer. We use that chunk as the source text, but we do
not require the entire raw chunk to appear exactly in React-PDF's page DOM.

Why raw equality is unreliable
------------------------------

The backend extraction pipeline and React-PDF text layer can represent the same
visible sentence differently:

```text
chunk: quantization improves model performance
page:  quantiza-\ntion improves   model performance
```

PDFs can also contain line breaks, multiple spaces, compatibility ligatures such
as fi, different Unicode forms, smart punctuation, and text fragmented into many
positioned spans. A chunk may include overlap or multiple paragraphs, so its
complete text may not exist as one continuous string on the cited page.

Shared workspace request
------------------------

DocumentWorkspaceClient.handleCitationSelect() now puts chunkId and content in
the same PageNavigationRequest as pageNumber and requestId:

```text
{
  pageNumber,
  requestId,
  chunkId,
  content
}
```

PdfViewer receives these as targetPage, targetPageRequestId, targetChunkId, and
targetContent. It still performs scrollToPage(targetPage) independently. The
same values are passed to PdfDocument only for the optional highlight attempt.

Chunk normalization
-------------------

normalizeCitationText() in citation-matching.ts prepares backend chunk content.
It applies Unicode NFKC compatibility normalization, expands known ligature
characters, lowercases text, removes line-wrap hyphenation, converts punctuation
and whitespace differences into single spaces, and keeps letters and numbers.

Ordinary hyphens are not blindly joined. cross-encoder normalizes to the same
two words on both sides. Only a hyphen directly followed by a chunk line break
is treated as a wrapped word and joined.

Rendered-page normalization with position mapping
-------------------------------------------------

PdfDocument's highlighting effect gets the target page wrapper from pageRefs and
queries its .react-pdf__Page__textContent span elements. These are the actual
positioned text spans produced by React-PDF.

For every span it records:

```text
text            -> span.textContent
sourceIndex     -> the span's index in the page array
lineBreakBefore -> whether its visual top changed from the previous span
```

The visual top comparison matters for wrapped hyphenation. If one line ends in
a hyphen and the next line starts with a lowercase letter, normalizePageFragments()
joins the two normalized pieces without inserting a space.

normalizePageFragments() returns:

```text
text          -> one normalized searchable page string
sourceIndexes -> normalized character position to React-PDF span index
```

The mapping is required because normalization changes string lengths. A ligature
can expand into two letters, many spaces can collapse into one, and a wrapped
hyphen can disappear. We search normalized text, then use sourceIndexes to get
back to the real spans that need CSS styling.

Distinctive passage selection
-----------------------------

matchCitationPassage() normalizes the chunk and divides it into words. It tests
candidate windows in this order:

```text
24 words -> 18 -> 12 -> 8 -> 6 -> 4
```

This prefers a meaningful portion of the chunk instead of requiring the full
chunk to match. Longer windows and windows containing more non-common words get
higher scores. A long phrase such as quantization policy network and task
specific BERT network is safer than a generic phrase such as the results show.

Every candidate is searched with word boundaries. A candidate is accepted only
when it occurs exactly once on the target page. If text repeats, the matcher does
not choose the first occurrence. It tries other longer or more distinctive
windows. If no candidate becomes unique, it returns null and produces no
highlight. Skipping an uncertain highlight is safer than marking the wrong text.

Mapping the match back to spans
-------------------------------

When matchCitationPassage() returns normalized start and end positions,
PdfDocument slices sourceIndexes across that range and creates a Set of matched
span indexes. A Set prevents the same span being processed repeatedly when many
matched characters came from it. Each resolved span receives the
corpus-citation-highlight CSS class.

globals.css gives that class a marker-colored background, outline, and rounded
corners. Before every new attempt, PdfDocument removes the class from previous
matches so only the selected citation stays highlighted.

React-PDF may recreate text spans after a zoom. Page's
onRenderTextLayerSuccess callback calls handleTextLayerRendered(). For the target
page this increments textLayerRevision, causing the highlight effect to run
again against the new spans.

Graceful failure and complete flow
----------------------------------

Highlighting is best effort. Missing page spans, empty content, ambiguous text,
or no sufficiently distinctive match causes the effect to return without adding
a class. None of those paths undo or block page navigation.

```text
citation click
-> selectCitation(source)
-> handleCitationSelect(source)
-> scroll target page using pageNumber
-> pass chunk content to PdfDocument
-> collect target page text spans
-> normalize chunk content
-> normalize page spans plus source-index map
-> search distinctive candidate windows
-> require a unique page occurrence
-> map normalized range back to spans
-> add corpus-citation-highlight class

if any matching step fails:
-> keep the successful page jump
-> show no highlight
-> never guess a location
```

12. Center the matched passage after highlighting
-------------------------------------------------

The highlight class was already applied to every matched React-PDF text span.
The remaining behavior was a more precise scroll. Previously scrollToPage()
opened the correct page, but the matched sentence could still sit near the
bottom or outside the visible part of a long rendered page.

After PdfDocument builds matchedSpanIndexes and adds
corpus-citation-highlight, it reads the first index from the Set and resolves
the corresponding real span:

```text
matchedSpanIndexes.values().next().value
-> spans[firstMatchedIndex]
-> firstMatchedSpan
```

A Set keeps insertion order, and sourceIndexes came from the normalized match
range in reading order, so this is the first span belonging to the passage.

PdfDocument schedules the DOM movement with requestAnimationFrame(), then calls:

```text
firstMatchedSpan.scrollIntoView({
  behavior: smooth,
  block: center,
  inline: nearest
})
```

block center places the passage around the vertical center of the PDF pane.
inline nearest avoids unnecessary horizontal movement. Scheduling one animation
frame allows the highlight classes and latest text-layer DOM to settle first.
The effect cleanup cancels a pending frame if another citation is selected
before it runs.

There are now two deliberate navigation levels:

```text
level 1, always available:
source.pageNumber -> PdfViewer.scrollToPage() -> open cited page

level 2, only after a confident match:
first highlighted text span -> scrollIntoView() -> center passage
```

If normalization or passage matching fails, level 2 never runs, but level 1 has
already opened the correct page. Highlighting and precise scrolling therefore
remain enhancements rather than requirements for basic citation navigation.

13. Unit tests for citation matching and SSE parsing
----------------------------------------------------

Added a web test command:

```text
npm run test:unit -w web
```

The command runs TypeScript Node tests through tsx. The test files live beside
the pure frontend helpers they verify:

```text
web/src/lib/citation-matching.test.ts
web/src/lib/query-stream.test.ts
```

Citation normalization and matching tests
-----------------------------------------

The citation suite verifies seven cases:

```text
normal text       -> a distinctive passage is found
multiple spaces   -> collapse to one searchable space
line breaks       -> normalize like ordinary spaces
wrapped hyphen    -> quantiza- plus newline plus tion becomes quantization
ligatures         -> fi, ffi, and fl compatibility forms expand correctly
repeated passage  -> ambiguous occurrence returns null
no match          -> unrelated page and chunk return null
```

The wrapped-hyphen test uses normalizePageFragments() with two different source
span indexes and a visual line break. It confirms that backend chunk
normalization and rendered-page normalization produce the same searchable text.

SSE parser tests
----------------

The SSE suite verifies six required transport cases:

```text
one complete frame     -> parseSseEvent returns the token event
frame split over reads -> streamQuery reconstructs split event and JSON bytes
many frames in one read-> callbacks run in protocol order
malformed JSON         -> parser throws instead of accepting invalid data
done event             -> authoritative answer and source data are returned
error event            -> onError runs and streamQuery rejects
```

streamingResponse() builds a real ReadableStream of Uint8Array chunks with
TextEncoder. withMockFetch() temporarily replaces browser fetch and restores it
in finally. This lets the tests exercise the real response.body.getReader(),
TextDecoder, protocol buffer, parseSseEvent(), dispatchEvent(), and streamQuery()
flow without contacting Next or Hono.

The split-frame test deliberately cuts one event inside the data field and JSON
string. The multiple-events test puts conversation, status, token, and done into
one network chunk. Together they prove that network read boundaries do not need
to match SSE frame boundaries.

Test result on 2026-08-15:

```text
13 tests
13 passed
0 failed

ESLint passed
TypeScript noEmit check passed
```

14. Persisted conversation IDs and reopened chat history
--------------------------------------------------------

Main files:

```text
server/migrations/009_message_sources.sql
server/src/lib/db.ts
server/src/services/query.ts
server/src/services/query-stream.ts
server/src/routes/documents.ts
web/src/lib/api.ts
web/src/app/documents/[id]/page.tsx
web/src/components/document-workspace-client.tsx
web/src/components/document-chat.tsx
server/test/conversation-history.integration.test.ts
```

Same-page conversation reuse was already present
------------------------------------------------

DocumentChat stores conversationId in React state. The first question sends no
ID. prepareQuery() in server/src/services/query.ts sees the missing value and
calls Conversations.create(documentId). streamPreparedQuery() sends the new ID
in its conversation SSE event before answer tokens begin.

streamQuery() dispatches that event to DocumentChat's onConversation callback:

```text
onConversation: id -> setConversationId(id)
```

The next handleSubmit() call reads the saved state and includes conversationId
in the POST body. prepareQuery() then calls Conversations.getByIdForUser() rather
than creating another conversation. It also checks conversation.document_id
against the requested documentId, so history from one PDF cannot be mixed with
another PDF.

This already supported follow-up questions while the component remained
mounted. It did not survive refresh because React state is memory, not storage.

Persisting citation sources with assistant messages
---------------------------------------------------

The existing messages table stored role and content but not the sources used by
an assistant answer. Reopening could therefore restore answer text but could not
recreate citation buttons or PDF navigation.

Migration 009_message_sources.sql adds a non-null sources JSONB array with an
empty-array default and a database check requiring JSON array data. Existing
messages become sources = [] automatically. Their old citation metadata cannot
be reconstructed, but new messages preserve it.

db.ts defines StoredMessageSource using the frontend/backend source fields:

```text
label
chunkId
documentId
pageNumber
content
similarity
```

Messages.create() now accepts sources as an optional fourth argument. User
messages and no-source answers continue using the default empty array. Completed
assistant paths in query.ts and query-stream.ts pass validated.sources when they
save validated.answer. PostgreSQL returns JSONB as the source array on MessageRow.

The sources are a snapshot of the exact retrieval context cited by that answer.
Reopening does not rerun embedding, retrieval, RRF, or reranking, which could
produce different results later.

Ownership-scoped latest conversation lookup
-------------------------------------------

Conversations.getLatestForDocumentForUser(documentId, userId) joins
conversations to documents and requires documents.user_id. It orders newest
first and returns one row. The join prevents a caller from retrieving a foreign
conversation merely by knowing its document ID.

The new protected endpoint is:

```text
GET /documents/:documentId/conversation
```

It lives in the existing documents router, so documentsRoute.use(requireAuth)
protects it automatically. The route first calls Documents.getByIdForUser(). A
missing or foreign document returns the same 404.

An owned document with no conversation is a valid empty chat and returns:

```text
{
  conversation: null,
  messages: []
}
```

When a conversation exists, the route calls
Messages.getByConversationId(conversation.id). That helper orders by created_at
and id, so the frontend receives natural user/assistant order. The route maps
database snake_case rows into a camelCase public response containing the
conversation and each message's ID, role, content, sources, and createdAt.

Server-rendered history loading
-------------------------------

web/src/lib/api.ts defines DocumentConversationResponse and
getDocumentConversation(documentId). It uses the existing request() helper, so
this Next server request forwards the HttpOnly cookie to Hono and preserves Hono
errors through ApiError.

WorkspacePage first calls loadDocument(id). This retains the established 404
handling for missing and foreign documents. After ownership succeeds, it calls
getDocumentConversation(id) and passes these serializable values into
DocumentWorkspaceClient:

```text
initialConversationId = persistedChat.conversation?.id
initialMessages       = persistedChat.messages
```

DocumentWorkspaceClient forwards both into DocumentChat. DocumentChat uses lazy
useState initializers to convert every persisted message into its local
ChatMessage shape. Database messages are finalized records, so they start with
status done. Their database IDs remain React keys, and their stored sources
immediately recreate citation buttons.

DocumentChat initializes conversationId from initialConversationId. Therefore a
question asked after reopening sends the persisted ID and continues the same
backend history rather than creating a new conversation.

Complete reopen and follow-up flow
----------------------------------

```text
open /documents/:id
-> WorkspacePage.loadDocument(id)
-> getDocumentConversation(id)
-> Next request() forwards cookie to Hono
-> requireAuth validates active database session
-> document ownership check
-> newest conversation lookup
-> ordered messages plus stored sources
-> DocumentChat initializes messages and conversationId

ask follow-up
-> handleSubmit()
-> streamQuery() includes persisted conversationId
-> prepareQuery() verifies conversation ownership and document relationship
-> load recent messages for rewrite and generation
-> save new user and assistant messages
-> save assistant validated sources
-> live UI updates through SSE

refresh again
-> newest conversation and all finalized messages are restored
-> citation buttons have the same source snapshots
```

Start over still clears local conversationId and messages. The next submitted
question omits conversationId, causing prepareQuery() to create a new database
conversation. Older conversations are preserved rather than deleted.

Verification state on 2026-08-15
--------------------------------

Added conversation-history.integration.test.ts. It covers newest-conversation
selection, chronological message loading, stored citation sources, an owned
document with no chat, and foreign-document 404 behavior.

Postgres was not listening on localhost:5432, so migration 009 and this focused
integration test could not run yet. The migration command failed with
ECONNREFUSED before applying anything.

Checks that completed successfully:

```text
web unit tests: 13 passed
server unit tests: 50 passed
web ESLint: passed
web TypeScript: passed
server TypeScript: passed
```

When Docker/Postgres is available, run:

```text
npm run migrate -w server
npx tsx --env-file=server/.env --test --test-concurrency=1 server/test/conversation-history.integration.test.ts
```

15. Keep user-facing progress language simple
---------------------------------------------

Audited visible frontend copy for implementation terms such as vector search,
keyword retrieval, RRF, reranking, embeddings, chunks, indexed passages, and
search indexes.

These terms remain in TypeScript types, backend status values, tests, comments,
and technical logs because developers need precise names. They were removed
from product-facing text because users need to know what the application is
doing for them, not which retrieval algorithm performs it.

Visible states now use language such as:

```text
uploading PDF
waiting to process
preparing document
processing
ready
processing failed
Processing...
answers are based only on this document
```

The document workspace header now shows ready plus the page count rather than
the internal chunk count. Library cards show ready plus pages. The library
summary shows how many documents are ready instead of how many passages were
indexed. Retry indexing became Retry processing.

The login screen no longer advertises retrieval-augmented Q&A or combined vector
and keyword search. It explains the product behavior directly: Corpus reads PDFs,
answers from the document, and lets the user open supporting text through
citations.

The chat does not display fake or overly technical retrieval stages. The backend
currently emits conversation, generating, finalizing, token, done, and error SSE
events, while vector retrieval, keyword retrieval, RRF, and reranking happen
before streaming begins. Since there are no real frontend events for those
individual stages, the UI does not claim that they are occurring in real time.

Technical understanding remains visible in the codebase, architecture logs,
tests, and portfolio documentation. The normal user interface stays focused on
progress, answers, sources, pages, and recoverable errors.
