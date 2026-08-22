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

Postgres was initially not listening on localhost:5432, so the first migration
attempt failed with ECONNREFUSED. After Postgres was started, migration 009
applied successfully and the focused conversation-history integration test
passed 1/1.

Checks that completed successfully:

```text
web unit tests: 13 passed
server unit tests: 50 passed
web ESLint: passed
web TypeScript: passed
server TypeScript: passed
```

Commands used for database verification:

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

16. Accessibility and reduced motion
------------------------------------

Main files:

```text
web/src/components/document-chat.tsx
web/src/components/pdf-viewer-client.tsx
web/src/components/pdf-viewer.tsx
web/src/components/pdf-document.tsx
web/src/lib/motion.ts
web/src/app/globals.css
```

Live chat announcements
-----------------------

The message container in DocumentChat is now role log with aria-live polite and
aria-relevant additions text. A log represents chronological content appended
over time, which matches user and assistant messages. polite tells assistive
technology to announce updates without interrupting speech already in progress.

The container does not use aria-busy while streaming. Some screen readers defer
live-region announcements while a region is busy, which could hide token updates
until the answer finished. Processing... has role status so the pre-token state
is announced. Each message article has an accessible label of Your question or
Assistant answer, and existing technical failures remain role alert.

Accessible citations and keyboard behavior
------------------------------------------

Citations remain native button elements. Native buttons enter the Tab order and
activate with Enter or Space without custom keydown code. Their aria-label now
describes the action and destination, for example Open source S1 on PDF page 3.
A source without page metadata announces that its page is unavailable.

aria-pressed continues exposing which source is selected, and focus-visible
styles show keyboard users where focus currently sits. The chat input is inside
a form, so Enter submits naturally. Stop generating, Start over, Send, Previous,
Next, and zoom controls are also native buttons.

PDF control labels and keyboard access
--------------------------------------

The page-navigation and zoom containers use role group plus accessible names.
Previous and Next now announce Previous PDF page and Next PDF page, and both use
aria-controls to identify pdf-page-scroll-region as the region they affect.

The current page counter is role status with aria-live polite and aria-atomic
true. Atomic announcement means a change is read as the complete value, such as
3 / 10, rather than an isolated changed character. The zoom value includes
screen-reader-only Current zoom text while keeping the compact visible percent.

The PDF page scroller is a labelled region with tabIndex 0. Keyboard users can
focus it and use normal browser scrolling keys without needing to click inside
the PDF first. A focus-visible outline makes that location clear.

PDF preparation and loading text use role status plus aria-live polite. PDF
rendering failure uses role alert.

Reduced-motion behavior
-----------------------

prefers-reduced-motion is an operating-system/browser media preference set by
users who find animation distracting or uncomfortable.

globals.css now has a reduce media query that disables CSS animations, reduces
transitions to almost immediate changes, and forces CSS scroll behavior to auto.
This covers document-card pulse indicators, loading skeleton pulses, decorative
login animation, and other CSS-driven motion while preserving static content.

JavaScript scrollIntoView behavior is not fully controlled by CSS. motion.ts
therefore defines accessibleScrollBehavior():

```text
matchMedia prefers-reduced-motion: reduce -> auto
otherwise                                -> smooth
```

PdfViewer.scrollToPage() and PdfDocument's matched-passage scroll both call this
helper. Users with ordinary motion preferences retain smooth page and citation
movement. Reduced-motion users jump directly without animated scrolling.

17. History source compatibility fix
------------------------------------

The document workspace crashed while rendering restored messages at
message.sources.length. The TypeScript contract said sources was always an
array, but runtime history returned at least one message without that property.

Migration 009 had previously failed to apply because Postgres was offline. This
created a deployment mismatch: new frontend/backend code expected the JSONB
column while the running database still used the older message shape. TypeScript
cannot validate database responses at runtime, so its non-optional array type did
not prevent undefined data.

Added defensive defaults at both boundaries:

```text
Hono response mapping:
Array.isArray(message.sources) ? message.sources : []

DocumentChat initialization:
Array.isArray(message.sources) ? message.sources : []
```

The backend now keeps its public response stable during an old-row/schema
transition, and the frontend remains fail-safe if it talks to an older backend
or receives malformed history. Messages without source metadata render normally
without citation buttons rather than crashing the whole document workspace.

After the compatibility fix, migration 009_message_sources.sql applied
successfully. conversation-history.integration.test.ts passed 1/1, confirming
latest owned history, chronological messages, source restoration, empty history,
and foreign-document 404 behavior. Web unit tests passed 13/13, both TypeScript
checks passed, and web ESLint passed.

18. Phase 4 final verification
------------------------------

The ownership integration test now covers the protected PDF endpoint as well as
document, job, delete, normal query, and stream query access. The owner receives
the real PDF with Content-Type application/pdf. A different authenticated user
receives the same 404 used for a missing resource when requesting the PDF or
querying the document. This confirms that ownership is enforced without leaking
whether another user's resource exists.

The automated verification results were:

```text
server unit tests                 50 / 50 passed
server database integration      23 / 23 passed
web SSE and citation unit tests  13 / 13 passed
real reranker model test          1 / 1 passed
real Ollama stream parser test    1 / 1 passed
real query stream end to end      1 / 1 passed
server TypeScript                 passed
web TypeScript                    passed
web ESLint                        passed
web production build              passed
```

The browser test used a temporary account and a copied ready PDF, chunks, and
embeddings. The temporary user, document, conversations, messages, chunks,
session, and copied PDF were removed afterward.

The real browser flow confirmed login, the ready-document library card, the
workspace, all seven PDF canvases, all seven text layers, immediate display of
the user question, the Processing state, and a correct streamed answer. It also
confirmed that a citation button always moves the viewer to its stored page.

Two real-model/browser problems remain:

1. The local Ollama model returned a correct answer without an [S1] style label.
   SSE citation validation therefore returned no source buttons. This is the
   known streaming limitation: unlike the non-streaming path, it cannot retry
   after tokens have already been shown.
2. A second real query reached the generation timeout and produced the separate
   Query stream failed alert. The UI correctly removed the unfinished assistant
   message instead of leaving a permanent partial answer.

A deterministic persisted source was used to test the downstream citation UI.
The source chip rendered and clicking it changed the PDF pager to the correct
page, but the text did not highlight. Browser inspection found a likely render
loop in PdfDocument: onRenderTextLayerSuccess updates textLayerRevision, that
state update rerenders the Page, and rendering the text layer fires the callback
again. Production code was not changed during this test-only step. The loop and
the SSE citation reliability issue should be fixed before calling the complete
browser happy path fully green.

While the full development stack was running, the worker also claimed an older
pending ingestion job whose stored PDF no longer existed. It correctly marked
that job failed with ENOENT. This was unrelated to the temporary browser fixture,
but it confirms that a database job can outlive its storage file and should be
shown as a recoverable ingestion failure in the library.

19. Citation highlight render-loop fix
--------------------------------------

PdfDocument previously stored textLayerRevision in React state. When the cited
page's text layer completed, onRenderTextLayerSuccess incremented that state.
The state update rendered Page again, which completed the text layer again and
could repeat the same state update. This feedback loop kept recreating spans and
could remove or prevent the citation highlight.

The matching and DOM-highlighting work now lives in applyCitationHighlight(), a
plain helper that does not update React state. A citation selection first tries
the helper immediately because the text layer may already exist. The Page
onRenderTextLayerSuccess callback also calls it, covering initial PDF loading and
zoom changes where PDF.js creates fresh spans later.

The helper still behaves fail-soft: it only handles the selected page, removes
the old highlight, normalizes and matches the real text spans, adds the highlight
class, and centers the first matched span. A requestAnimationFrame ref cancels an
older pending scroll before scheduling a new one. None of these actions renders
the React component again, so text-layer completion cannot start a render loop.

After the refactor, web TypeScript, ESLint, and all 13 SSE/citation unit tests
passed.

20. Streaming citation correction
---------------------------------

The streaming service used to validate the completed token buffer once and then
discard every source when Ollama omitted [S1] labels. The answer could be correct
but the frontend received an empty sources array, leaving no citation buttons.

streamPreparedQuery() now keeps normal token streaming unchanged. After the
model finishes, it enters finalizing and validates the complete answer. Missing
or invalid labels trigger one non-streaming citation-correction request using
buildCitationRetryMessages(). This request receives the original grounded
messages, the answer already shown, and only the valid source labels.

The corrected response is used primarily as structured source selection. If its
wording is the same after ignoring citation labels, punctuation, whitespace, and
case, done.answer remains the exact streamed prose. Only done.sources changes,
so source chips appear without visually replacing the answer. If Ollama really
changes the wording, the corrected response becomes the authoritative done
answer and the frontend performs its existing one-time replacement.

If the correction itself fails, times out, or still returns no usable label, the
completed answer is not turned into a stream error. The service falls back to
the chunks that were genuinely retrieved and supplied as generation context.
Those sources are saved with the assistant message and sent in done, preventing
a formatting failure in the small local model from deleting all source access.

The integration test confirms that an uncited streamed answer causes exactly one
correction call, keeps its already-visible prose unchanged, returns S1 in the
done event, and persists that same source with conversation history. Server
TypeScript and all five focused stream service/route tests passed.

21. Passage-level citation highlighting
---------------------------------------

Highlighting previously received source.content, which is the entire retrieved
chunk. A chunk can contain several paragraphs, table headings, and the actual
supporting sentence. The browser matcher therefore found text from the correct
chunk but could mark a distinctive unrelated heading instead of the evidence
used by the answer.

ContextSource, StoredMessageSource, and the frontend source contracts now support
an optional highlightText field. content still means the complete chunk used for
generation and source previews. highlightText means the smaller passage selected
for visual PDF highlighting. Since message sources are JSONB, this did not need a
new database column and old messages remain compatible without the field.

citation-passages.ts performs the selection after final citation validation. It
maps each [S#] label to the sentence containing that cited claim, splits the
source chunk into sentence, neighbouring-sentence, and short-paragraph candidates,
then scores each candidate using meaningful word coverage and precision. Exact
numbers receive extra weight so numerical answers choose the right result row or
sentence. A minimum confidence threshold returns null when no passage is safe.

Both queryConversation() and streamPreparedQuery() call
selectCitationPassages() before saving and returning their final sources. The
streaming path uses the internally corrected labelled answer for claim mapping,
even when the already-streamed prose remains visually unchanged.

DocumentWorkspaceClient now passes source.highlightText to the PDF viewer instead
of source.content. If highlightText is absent or null, citation clicking still
navigates to the stored page but deliberately applies no highlight. This keeps
the feature fail-soft without painting unrelated text.

Tests cover choosing supporting prose over table headings, matching the correct
numeric passage including decimal values, refusing a low-confidence match, and
leaving unlabelled fallback retrieval sources unhighlighted. All 54 server unit
tests, five focused database/stream tests, both TypeScript checks, web ESLint, and
all 13 frontend unit tests passed.

Passage-source verification follow-up
-------------------------------------

A real new answer still produced highlightText null. Database inspection showed
this was intentional rather than a frontend failure: the answer listed flood,
conflict displacement, drought, and winterization scenarios but Ollama attached
S4, whose chunk contained none of those details. Searching only inside the cited
chunk could not find honest supporting text, so the confidence guard correctly
fell back to page-only navigation.

selectCitationPassages() now verifies each cited claim against every chunk that
was genuinely present in the five-source generation context. If another context
chunk contains the strongest confident passage, the citation keeps its visible
label but its chunk ID, page, complete source content, and highlightText are
reassigned to that actual evidence. If none of the supplied chunks support the
claim, highlighting remains disabled instead of hiding a hallucination behind an
unrelated mark.

A regression test now covers a model attaching S4 to a claim that is actually
supported by S2. The result retains visible label S4 while navigating to and
highlighting S2's supporting chunk and page. All 55 server unit tests, four
focused stream integration tests, and server TypeScript passed.

22. Table-aware PDF layout and chunking
---------------------------------------

PDF.js extraction now keeps each text run's rendered width. groupIntoLines()
uses x plus width to measure the empty horizontal gap before the next run. Runs
separated only by ordinary word spacing remain one cell, while a large gap starts
a new LineCell with its own text, minX, and maxX.

Table detection happens in layout.ts after line construction and column reading
order, while cell x positions still exist. A candidate row needs at least three
cells. This avoids confusing normal two-column page prose with a table. Several
consecutive candidate rows must have at least three aligned cell starts, stay on
the same page, and remain within a normal row gap. Numeric cells are a strong
table clue, while short aligned text allows a header row to join the numeric rows
below it.

groupIntoSections() replaces plain paragraph-only grouping. It keeps ordinary
lines in text sections and flushes them before a detected table. Table rows join
cells with ` | ` and rows with a newline:

```text
Model | Size | Accuracy
BERT | 324 | 93.5
Q-BERT | 30 | 92.5
```

layoutText() turns these sections into heading, paragraph, or table blocks. The
existing page-relative character offsets continue across all three block types.

chunk.ts treats a table as a hard chunk boundary. It flushes prose before the
table, stores a small table as its own chunk, and starts fresh afterward. An
oversized table splits by complete rows instead of sentence boundaries. Every
piece repeats the first row as its header so values keep their column meaning.
An unusually large single row falls back to word packing while still respecting
the 500-token maximum.

This improves future ingestion only. Existing chunks in Postgres do not change
until their PDFs are re-ingested.

Tests cover aligned three-cell table detection, rejection of ordinary two-column
prose, real table detection in the AQ-BERT fixture, table/prose chunk isolation,
header repetition across oversized table chunks, and token limits. All 60 server
unit tests passed. The five real ingestion/persistence integration tests and
server TypeScript also passed.

23. Faster repeat queries and honest progress states
----------------------------------------------------

generation.ts now sends `keep_alive: "10m"` in both normal and streaming Ollama
chat requests. The first request still pays the model-loading cost, but Ollama
keeps llama3.2 resident in memory for ten minutes afterward. Nearby questions,
follow-up rewrites, and citation correction can reuse the loaded model instead
of repeatedly loading it from disk into memory.

Citation repair now uses one shared CITATION_CORRECTION_OPTIONS value from
prompt.ts:

```text
maxTokens: 192
timeoutMs: 45000
```

Normal answers still allow up to 512 output tokens and 120 seconds. Correction
only needs to preserve prose and repair [S#] labels, so it receives a smaller
budget and cannot add another full-length generation delay. Both normal and SSE
query services use the same bounded correction options.

DocumentChat now stores a temporary progress string on the in-flight assistant
message. Immediately after submission it shows Finding relevant passages while
the Next request waits for Hono's prepareQuery work. Hono starts SSE only after
retrieval and reranking complete, so the first generating status changes the UI
to Writing the answer. Incoming tokens replace that label with live prose. The
finalizing status shows Checking sources below the completed prose while citation
validation, optional correction, passage selection, and message persistence run.
The done event removes the progress label and adds the authoritative sources.

These labels describe real stages without exposing internal names such as RRF or
cross-encoder reranking. They improve perceived responsiveness but do not claim
that retrieval itself became faster.

Tests confirm that both chat and chatStream send the ten-minute keep-alive and
that citation correction sends a 192-token request while retaining keep-alive.
All 61 server unit tests, five focused stream route/service tests, both TypeScript
checks, web ESLint, and all 13 frontend unit tests passed.

24. Query stage timing and first real measurement
-------------------------------------------------

query-timing.ts now creates one short request ID and records the start time of
each question. The same timing object travels from prepareQuery() into either
the normal or streaming answer path. This lets terminal lines from simultaneous
questions be grouped without logging the user's question or document content.

prepareQuery() measures the ownership lookup, conversation setup, history load,
user-message save, question rewrite, query embedding, keyword retrieval, vector
retrieval, RRF fusion, cross-encoder reranking, context construction, and prompt
construction. queryConversation() and streamPreparedQuery() then measure answer
generation, citation validation/correction, passage selection, assistant-message
persistence, and the complete request.

The streaming path has a separate generation_first_token measurement. This is
important because it distinguishes time spent waiting for the model to begin
from time spent receiving the generated answer after streaming has started.
The wrappers log a stage in a finally block, so an operation that throws or times
out still reports how long it occupied the pipeline.

A real streamed question against the existing ingested test document produced:

```text
retrieval and prompt preparation: 1294 ms
query embedding:                   185 ms
cross-encoder reranking:          1091 ms
wait for first Ollama token:    109915 ms
complete answer generation:     114662 ms
citation correction:             10211 ms
passage selection:                  38 ms
assistant message save:             48 ms
complete query:                  126262 ms
```

The measurements show that Postgres retrieval is not the present speed problem.
All retrieval and reranking finished in about 1.3 seconds, but Ollama needed about
109.9 seconds before returning the first token. After that first token arrived,
the remaining answer streamed in about 4.7 seconds. Citation correction added a
further 10.2 seconds because the first answer lacked usable citation labels.

Therefore the next optimization should target Ollama prompt processing and local
inference, then reduce how often citation correction is required. Changing keyword
SQL, vector SQL, or RRF would save milliseconds while leaving nearly all of the
user-visible delay untouched.

Back-to-back cold and warm query comparison
-------------------------------------------

The same real streamed query was later run twice back-to-back. Before the first
run, `ollama ps` showed no loaded model. After that run it showed llama3.2 loaded
for the configured ten-minute keep-alive window, with a 2.6 GB allocation and
`100% CPU` processing.

```text
                                cold run       warm run
retrieval and prompt setup:      1448 ms        1899 ms
wait for first token:          102708 ms        1456 ms
complete answer generation:    107944 ms        6527 ms
citation correction:            10802 ms       10408 ms
complete query:                120318 ms       18902 ms
```

This first comparison proved that `keep_alive: "10m"` worked, but it did not by
itself prove that model loading caused the entire 101-second difference. The warm
run repeated the exact same question and context, allowing Ollama to reuse prompt
work as well as keeping the model loaded. A later isolated warm-up test below
separated these effects.

25. Automatic Ollama warm-up
----------------------------

generation.ts now exports warmGenerationModel(). It sends an empty, non-streaming
request to Ollama's /api/generate endpoint for the same llama3.2 model used by
chat() and chatStream(). An empty request asks Ollama to load the model without
generating throwaway answer text. The request also sends `keep_alive: "10m"`, so
the loaded model remains available for nearby real questions.

The warm-up timeout is 180 seconds so a slow local load does not fail prematurely.
The response body is consumed even though its contents are not needed, allowing
the underlying HTTP connection to be reused cleanly.

index.ts calls warmGenerationModel() after serve() starts listening. It does not
await the call before starting the HTTP server. Authentication, uploads, document
viewing, and other non-LLM features therefore become available immediately while
Ollama loads in the background. A successful warm-up logs its elapsed time.

Warm-up failure is caught and logged rather than crashing the backend. If Ollama
is closed, the rest of Corpus can still run, and a later query can make its normal
request after Ollama becomes available. A focused unit test verifies that warm-up
uses /api/generate, llama3.2, non-streaming mode, and the ten-minute keep-alive.

Real warm-up verification and corrected conclusion
--------------------------------------------------

The helper was then tested against a genuinely unloaded Ollama instance. The
empty warm-up completed in 7.6 seconds. `ollama ps` afterward showed llama3.2
loaded at 2.6 GB, using 100% CPU, with nine minutes remaining. This proves that
the helper and keep-alive behavior work.

A real RAG query was immediately submitted while that model was still loaded:

```text
retrieval and prompt setup:       1323 ms
wait for first token:            90462 ms
complete answer generation:      95199 ms
citation correction:             10196 ms
complete query:                 106803 ms
```

The preload saved some cold-start time, but a new full RAG prompt still took about
90.5 seconds before its first token. Therefore model loading was not the main
source of the original 102.7-second delay. The earlier 1.46-second repeated run
also benefited from Ollama reusing the identical prompt. On this machine, prompt
evaluation for a new context while running entirely on CPU is the main remaining
bottleneck. Warm-up remains useful, but prompt-size reduction, a smaller model,
or supported GPU acceleration are now higher-impact optimizations.

26. Reduce final generation context from five sources to three
---------------------------------------------------------------

prepareQuery() still performs vector and keyword retrieval over 20 candidates,
fuses those results, and sends the strongest 15 candidates through the
cross-encoder. Only the final context selection changed from the best five
reranked chunks to the best three. Retrieval breadth and reranking quality are
therefore preserved while Ollama receives less text.

Before changing the limit, the real AQ-BERT question prompt was measured:

```text
                            five sources    three sources
document context tokens:       2338            1419
complete prompt tokens:        2594            1675
```

Three sources remove 919 prompt tokens, about 35%. The retrieval evaluation was
also rerun before the change. Every expected chunk across all eight evaluation
questions ranked first or second after cross-encoder reranking, so top-three
context preserved 100% retrieval recall for the current evaluation set.

The same real streamed question was then run with llama3.2 preloaded, matching
the conditions of the previous five-source test:

```text
                              five sources    three sources    change
retrieval and prompt setup:      1323 ms         1371 ms       normal variance
wait for first token:           90462 ms        54527 ms       39.7% faster
complete answer generation:     95199 ms        58935 ms       38.1% faster
citation correction:            10196 ms            0 ms       not needed this run
complete query:                106803 ms        60383 ms       43.5% faster
```

The factual end-to-end assertions passed, including all four expected NLP task
names, streaming completion, and database persistence. This verifies that the
smaller prompt materially improves CPU generation for the tested document while
preserving the expected answer.

The missing citation-correction cost is encouraging but should not be treated as
guaranteed: citation formatting is model-generated and another question may
still trigger correction. The first-token reduction is the cleaner measure of
the context change because it occurs before citation validation or correction.

27. Deterministic citation attribution replaces generation retry
---------------------------------------------------------------

The query pipeline no longer asks Ollama to rewrite a completed answer when its
source labels are missing or invalid. The original answer remains unchanged and
only one generation request is made. The citation instructions remain in the
main prompt because valid model labels still provide useful claim-to-source
intent when the model follows them.

citation-passages.ts now exports attributeAnswerSources(). It removes citation
markers, splits the answer into sentence-sized claims, and treats those claims as
temporary matching inputs. Each claim is compared with passage candidates from
all three chunks that genuinely entered the generation prompt. Existing lexical
coverage, precision, and exact-number scoring choose the strongest support.

Only a match above the existing confidence threshold becomes a citation. A weak
"least bad" chunk is not returned. Refusal sentences receive no citation. If one
chunk supports several claims, the returned sources are deduplicated by chunk ID
and the strongest passage becomes that source's highlightText.

The return value contains source chunks, not claim objects. Every returned item
keeps its chunk ID, document ID, page, full source content, retrieval metadata,
and label, while adding the precise supporting passage as highlightText. The
frontend can therefore render its existing source chip and navigate/highlight
the PDF without requiring an inline [S#] marker in the generated prose.

Both queryConversation() and streamPreparedQuery() now follow this decision:

```text
valid model labels
-> verify labels and passages with selectCitationPassages()

missing or invalid model labels
-> attribute claims locally with attributeAnswerSources()
```

The old CITATION_CORRECTION_OPTIONS and buildCitationRetryMessages() code was
removed. The streaming path no longer risks changing prose after tokens have
already been displayed, timing out during a secondary generation, or spending
another roughly ten seconds on citation formatting.

Tests cover unlabeled answers, selection among competing chunks, multiple claims
supported by one chunk, unsupported claims, refusals, number-sensitive matching,
wrong model labels, and table-heading avoidance. The database-backed streaming
test proves the missing-label path makes exactly one Ollama request, returns the
supporting source and highlight, and persists both with the unchanged answer.

The real three-source AQ-BERT query passed with all expected facts, streamed
tokens, returned source metadata, and persisted sources. Its uncached run took
59.3 seconds total. That answer supplied valid labels itself, so deterministic
fallback was not needed in that particular run. A second identical run completed
in 6.9 seconds because Ollama reused the identical prompt; that cached number is
not used as the optimization benchmark.

Verification passed: 65 server unit tests, 24 PostgreSQL integration tests, the
real Ollama/PostgreSQL SSE test, server TypeScript, and git diff validation.

Step 4: PDF viewer and citation polish audit

The protected PDF still follows the same path: React-PDF requests the same-origin
Next route at /api/documents/:id/pdf, Next forwards the HttpOnly cookie to Hono,
Hono authenticates and checks ownership, and Next returns the upstream PDF body
without converting it to text. Missing, foreign, and unavailable PDFs remain
safe error responses rather than exposing storage paths.

The viewer now gives explicit citation feedback. A new citation request first
shows that Corpus is opening the page and locating the passage. PdfDocument then
reports either highlighted or not-found to PdfViewer. The final status says that
the passage was highlighted, or that the correct page opened but exact matching
was unavailable. The request ID is stored with the result so a late callback
from an older citation cannot overwrite a newer click. Manual Previous or Next
navigation dismisses stale citation feedback.

PDF load errors now explain that the file may be unavailable or inaccessible and
offer Try loading again. The retry remounts PdfDocument with a new key, which
causes React-PDF to request and parse the protected PDF again. Loading text was
also changed to Loading document pages so it describes the actual operation.

Page and zoom bounds now live in pure helpers in pdf-viewer-state.ts. Page
requests clamp to 1 through totalPages and return null before a PDF has loaded.
Zoom remains between 75 and 200 percent.

Citation span construction and matching were separated into testable helpers in
citation-matching.ts. React-PDF span text and top positions become line-aware
fragments, normalization maps characters back to source spans, and matching
returns only the span indexes belonging to the unique supporting passage. Tests
now run the same passage at 75, 100, 125, 150, and 200 percent zoom and confirm
that every scale selects the same spans.

Table behavior remains layered. Ingestion keeps tables separate from prose, and
oversized table pieces repeat their header. Citation passage selection keeps the
source chunk content, including its header and row context, while normal visual
highlighting still prefers answer-supporting prose over nearby headings. A new
test verifies that table header and supporting-row information survive citation
selection.
