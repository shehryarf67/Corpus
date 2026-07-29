import { extractTextRuns, type TextRun } from './extract.js'

type Line = {
    text: string
    page: number
    y: number
    fontSize: number
}

type Paragraph = { text: string; page: number; fontSize: number }

type Block = {
  type: 'heading' | 'paragraph'
  text: string
  page: number
  charStart: number
  charEnd: number
}

const LINE_Y_TOLERANCE = 2

// Normal line spacing within a paragraph is roughly 1.2x the font size.
// A gap past ~1.6x is treated as a paragraph break rather than just the
// next line of the same paragraph. Relative to font size, not a fixed
// point value, so it holds up across both small footnote text and large
// headings.
const PARAGRAPH_GAP_FACTOR = 1.6

// Font size differences bigger than this between adjacent lines are also
// treated as a paragraph/section break, even if the vertical gap alone
// wouldn't have triggered one.
const FONT_SIZE_CHANGE_TOLERANCE = 1

// A line/paragraph is classified as a heading when its font size is this
// many times the document's baseline (body text) font size.
const HEADING_SIZE_FACTOR = 1.3

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0)
}

function groupIntoLines(runs: TextRun[]): Line[] {
  // Reading order: page first, then descending y (PDF y grows upward, so a
  // *larger* y is higher on the page), then ascending x (left to right)
  // for fragments that end up sharing a line.
  const sorted = [...runs].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)

  const lines: Line[] = []

  // The line currently being built, or null if we haven't started one yet.
  // We can't push a finished Line into `lines` until we know no more
  // fragments are going to join it.
  let current: { texts: string[]; page: number; y: number; fontSize: number } | null = null

  for (const run of sorted) {
    const belongsToCurrentLine =
      current !== null &&
      current.page === run.page &&
      Math.abs(current.y - run.y) < LINE_Y_TOLERANCE

    // current is used as a guard for the conditions as if not used,
    // the compiler cannot proceed, flagging it as unsafe
    if (belongsToCurrentLine && current) {
      current.texts.push(run.text)
      // Take the largest fragment size on the line — covers cases like an
      // inline superscript rendering slightly smaller than the rest.
      current.fontSize = Math.max(current.fontSize, run.fontSize)
    } else {
      // Doesn't belong with the current line — close it off (if there was
      // one) and start a new one seeded with this fragment.
      if (current) {
        lines.push({
          text: current.texts.join(' '),
          page: current.page,
          y: current.y,
          fontSize: current.fontSize,
        })
      }
      current = { texts: [run.text], page: run.page, y: run.y, fontSize: run.fontSize }
    }
  }

  // The loop only closes a line when it hits a fragment that starts a new
  // one — the very last line never triggers that, so it has to be flushed
  // manually here.
  if (current) {
    lines.push({
      text: current.texts.join(' '),
      page: current.page,
      y: current.y,
      fontSize: current.fontSize,
    })
  }

  return lines
}


function groupIntoParagraphs(lines: Line[]): Paragraph[] {
  const paragraphs: Paragraph[] = []

  // The paragraph currently being built, or null if we haven't started one yet.
  let current: { texts: string[]; page: number; fontSize: number } | null = null

  // The last individual Line we looked at. Paragraph doesn't keep a `y`
  // field (it's not meaningful once multiple lines are folded together),
  // but the gap check below needs the previous *line's* y specifically —
  // so it's tracked separately from `current`.
  let previousLine: Line | null = null

  for (const line of lines) {
    const startsNewParagraph =
      current === null ||
      previousLine === null ||
      previousLine.page !== line.page ||
      Math.abs(previousLine.fontSize - line.fontSize) > FONT_SIZE_CHANGE_TOLERANCE ||
      Math.abs(previousLine.y - line.y) > line.fontSize * PARAGRAPH_GAP_FACTOR

    if (startsNewParagraph) {
      // Close off the paragraph being built, if there was one, before
      // starting a new one seeded with this line.
      if (current) {
        paragraphs.push({ text: current.texts.join(' '), page: current.page, fontSize: current.fontSize })
      }
      current = { texts: [line.text], page: line.page, fontSize: line.fontSize }
    } else if (current) {
      current.texts.push(line.text)
    }

    // Updated every iteration, regardless of which branch ran above, so the
    // next line always has the immediately-preceding line to compare against.
    previousLine = line
  }

  // Same as groupIntoLines: the loop only closes a paragraph when it hits
  // a new one, so the last paragraph in the document needs a manual flush.
  if (current) {
    paragraphs.push({ text: current.texts.join(' '), page: current.page, fontSize: current.fontSize })
  }

  return paragraphs
}

export async function layoutText(fileBuffer: Buffer): Promise<Block[]> {
  const runs = await extractTextRuns(fileBuffer)
  const lines = groupIntoLines(runs)
  const paragraphs = groupIntoParagraphs(lines)

  // Whole-document view, needed before classifying any individual
  // paragraph — this is why it can't live inside groupIntoParagraphs,
  // which only ever compares two neighboring lines at a time.
  const baselineFontSize = median(lines.map((line) => line.fontSize))
  const headingThreshold = baselineFontSize * HEADING_SIZE_FACTOR

  const blocks: Block[] = []

  // Running per-page character offset. Resets to 0 whenever the page
  // changes, since char_start/char_end are page-relative (the chunks
  // table already has a separate page_number column).
  let charOffset = 0
  let currentPage = -1

  for (const paragraph of paragraphs) {
    if (paragraph.page !== currentPage) {
      currentPage = paragraph.page
      charOffset = 0
    }

    const charStart = charOffset
    const charEnd = charStart + paragraph.text.length

    blocks.push({
      type: paragraph.fontSize > headingThreshold ? 'heading' : 'paragraph',
      text: paragraph.text,
      page: paragraph.page,
      charStart,
      charEnd,
    })

    // +1 accounts for the separator that would join this block to the next
    // one if the page's blocks were concatenated back into one string.
    charOffset = charEnd + 1
  }

  return blocks
}
