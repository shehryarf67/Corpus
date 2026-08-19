import { createRequire } from 'node:module'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

const pdfjsModuleUrl = import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs')
const pdfjsRequire = createRequire(pdfjsModuleUrl)
const { createCanvas } = pdfjsRequire('@napi-rs/canvas') as typeof import('@napi-rs/canvas')

pdfjsLib.GlobalWorkerOptions.workerSrc = import.meta.resolve(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs'
)

const THUMBNAIL_WIDTH = 480

/** Render page one once, at card resolution, instead of loading a full PDF per card. */
export async function renderFirstPageThumbnail(fileBuffer: Buffer): Promise<Buffer> {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(fileBuffer) })
  const pdfDocument = await loadingTask.promise

  try {
    const page = await pdfDocument.getPage(1)
    const originalViewport = page.getViewport({ scale: 1 })
    const scale = THUMBNAIL_WIDTH / originalViewport.width
    const viewport = page.getViewport({ scale })
    const canvas = createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height)
    )

    // PDF.js's public type describes a browser canvas. @napi-rs/canvas
    // implements the same drawing API for Node, so this narrow cast bridges
    // the two type definitions without weakening the rest of this file.
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport,
      background: '#ffffff',
    }).promise

    return canvas.toBuffer('image/png')
  } finally {
    // Destroy the loading task to release its worker and parsed PDF resources.
    await loadingTask.destroy()
  }
}
