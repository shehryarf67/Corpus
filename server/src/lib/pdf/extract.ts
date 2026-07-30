// pdfjs-dist ships a browser build at the package root and a "legacy" build
// specifically for non-browser environments like Node. Importing from the
// root here would pull in code written to assume a DOM/Web Worker, which
// isn't available in a server process.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

// pdfjs doesn't export TextItem from its public entry point (it lives under
// an internal types path that isn't part of the package's supported API),
// so we declare the handful of fields we actually read off each item
// ourselves rather than depending on an unexported internal type.
type PdfTextItem = {
  str: string
  transform: number[]
  fontName: string
}

// In a browser, pdfjs runs parsing inside a Web Worker so the UI thread
// doesn't freeze on large PDFs. Node has no browser-style Worker global by
// default, so instead of letting pdfjs fall back to fetching a worker
// script from a CDN (unreliable, and an unnecessary network dependency for
// a backend service), we point it at the worker file already sitting in
// node_modules.
pdfjsLib.GlobalWorkerOptions.workerSrc = import.meta.resolve(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs'
)

// A single run of text pulled off a page, with the position/font metadata
// pdf-parse would have thrown away. This is the raw material the chunker's
// heading/paragraph heuristics will need later — this module's only job is
// to get it out of the PDF, not to interpret it.
export type TextRun = {
  text: string
  page: number
  x: number
  y: number
  fontSize: number
  fontName: string
  // True for text drawn at a significant angle (e.g. a sideways preprint
  // watermark along the page margin). Layout logic downstream assumes
  // upright, horizontal text — a rotated fragment's x/y anchor doesn't
  // mean "this text visually sits here" the way it does for normal text,
  // so callers should generally exclude these rather than try to place them.
  isRotated: boolean
}

// How far a fragment's text direction can be from perfectly horizontal (0°)
// or upside-down (180°) before it's considered rotated rather than just
// minor rendering jitter.
const ROTATION_TOLERANCE_DEGREES = 10

export async function extractTextRuns(fileBuffer: Buffer): Promise<TextRun[]> {
    // We use Buffer instead of Array for better performance on large PDFs, since it avoids an extra copy of the data.
  // pdfjs's document loader expects raw bytes as a Uint8Array, not a Node Buffer.
  const data = new Uint8Array(fileBuffer)
  const pdfDocument = await pdfjsLib.getDocument({ data }).promise

  const runs: TextRun[] = []

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
    const page = await pdfDocument.getPage(pageNumber)
    const textContent = await page.getTextContent()

    for (const item of textContent.items) {
      // getTextContent() returns a mix of TextItem (actual text) and
      // TextMarkedContent (structural markers, e.g. marked-content
      // begin/end) when includeMarkedContent is set. We didn't request
      // that, but items lacking `str` can still show up for whitespace-only
      // runs — skip anything that isn't real text.
      const textItem = item as PdfTextItem
      if (!textItem.str || !textItem.str.trim()) continue

      // `transform` is a 2D affine matrix [scaleX, skewX, skewY, scaleY, x, y].
      // pdfjs doesn't expose font size directly — it's derived from the
      // matrix's scale components, which is why this looks more involved
      // than just reading a `fontSize` field.
      const [scaleX, skewX, skewY, scaleY, x, y] = textItem.transform
      const fontSize = Math.sqrt((scaleX ?? 0) ** 2 + (skewX ?? 0) ** 2) ||
        Math.sqrt((skewY ?? 0) ** 2 + (scaleY ?? 0) ** 2)

      // The angle of the matrix's x-axis basis vector — for upright text
      // this points along positive x (angle ~0°); a 90°-rotated fragment
      // (like a sideways watermark) has scaleX/skewX swapped from normal,
      // putting this angle near ±90° instead.
      const rotationDegrees = Math.atan2(skewX ?? 0, scaleX ?? 0) * (180 / Math.PI)
      const distanceFromUpright = Math.min(
        Math.abs(rotationDegrees),
        Math.abs(180 - Math.abs(rotationDegrees))
      )
      const isRotated = distanceFromUpright > ROTATION_TOLERANCE_DEGREES

      runs.push({
        text: textItem.str,
        page: pageNumber,
        x: x ?? 0,
        y: y ?? 0,
        fontSize,
        fontName: textItem.fontName,
        isRotated,
      })
    }
  }

  return runs
}
