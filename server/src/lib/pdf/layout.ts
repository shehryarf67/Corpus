import { extractTextRuns, type TextRun } from './extract.js'

type Line = {
    text: string
    page: number
    y: number
    fontSize: number
    minX: number
    maxX: number
}

type Paragraph = { text: string; page: number; fontSize: number }

export type Block = {
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

// A line is treated as "full width" (title, author block — not confined to
// a single column) when its width is at least this fraction of the widest
// line on the page. Lines narrower than that are treated as column-restricted.
const WIDE_LINE_WIDTH_FACTOR = 0.6

// A gap between sorted left-edges this many times the typical (median) gap
// counts as a real column gutter, not just normal left-edge variation
// within a single column (indentation, justification).
const GUTTER_GAP_FACTOR = 3

// A gutter also has to be at least this many points wide regardless of the
// relative factor above — guards against the median gap itself being ~0
// (e.g. many lines sharing an identical left edge), which would otherwise
// make GUTTER_GAP_FACTOR's threshold 0 and treat any tiny variation as a
// new column.
const MIN_GUTTER_GAP = 20

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0)
}

function groupIntoLines(runs: TextRun[]): Line[] {
  // Rotated fragments (e.g. a sideways preprint watermark) don't have a
  // meaningful "visual row" y-position the way upright text does — their
  // anchor point can coincidentally land close to an unrelated line's y
  // and get fused into it. Drop them before line-grouping ever runs,
  // rather than trying to place them correctly.
  const upright = runs.filter((run) => !run.isRotated)

  // Reading order: page first, then descending y (PDF y grows upward, so a
  // *larger* y is higher on the page), then ascending x (left to right)
  // for fragments that end up sharing a line.
  const sorted = [...upright].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)

  const lines: Line[] = []

  // The line currently being built, or null if we haven't started one yet.
  // We can't push a finished Line into `lines` until we know no more
  // fragments are going to join it.
  let current: { texts: string[]; page: number; y: number; fontSize: number; minX: number; maxX: number } | null =
    null

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
      // Track the line's horizontal extent — needed later to tell a
      // full-width line (title, author block) apart from a line confined
      // to a single column.
      current.minX = Math.min(current.minX, run.x)
      current.maxX = Math.max(current.maxX, run.x)
    } else {
      // Doesn't belong with the current line — close it off (if there was
      // one) and start a new one seeded with this fragment.
      if (current) {
        lines.push({
          text: current.texts.join(' '),
          page: current.page,
          y: current.y,
          fontSize: current.fontSize,
          minX: current.minX,
          maxX: current.maxX,
        })
      }
      current = { texts: [run.text], page: run.page, y: run.y, fontSize: run.fontSize, minX: run.x, maxX: run.x }
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
      minX: current.minX,
      maxX: current.maxX,
    })
  }

  return lines
}

// Finds the x-positions where one column ends and the next begins, from
// the narrow (column-restricted) lines' left edges. Same idea as
// PARAGRAPH_GAP_FACTOR: sort the values, and any gap between neighbors
// that's much bigger than the typical gap is treated as a real boundary
// rather than ordinary within-column variation. Returns 0 boundaries for a
// single column, 1 for two columns, 2 for three, and so on — the count
// isn't assumed in advance, it falls out of however many real gaps exist.
function findColumnBoundaries(narrowLines: Line[]): number[] {
  // Pull out just the left-edge x of every line and sort ascending. Once
  // sorted, lines from the same column cluster tightly together (small
  // left-edge variation from indentation/justification), and real column
  // gutters show up as noticeably bigger jumps between clusters.
  const sortedX = narrowLines.map((line) => line.minX).sort((a, b) => a - b)

  // The distance from each x-value to the one right before it, e.g.
  // sortedX = [30, 32, 33, 250, 252] -> gaps = [2, 1, 217, 2]. Most gaps
  // here are small (within-column noise); one is huge (a real gutter).
  const gaps: number[] = []
  for (let i = 1; i < sortedX.length; i++) {
    gaps.push((sortedX[i] ?? 0) - (sortedX[i - 1] ?? 0))
  }

  // The cutoff for "this gap is a real column gutter, not just noise."
  // Relative check: bigger than GUTTER_GAP_FACTOR times the typical
  // (median) gap. Absolute floor: at least MIN_GUTTER_GAP points
  // regardless, so a near-zero median (many lines sharing one left edge)
  // can't drag the threshold down to ~0 and flag tiny noise as a boundary.
  const gutterThreshold = Math.max(median(gaps) * GUTTER_GAP_FACTOR, MIN_GUTTER_GAP)

  // Walk the same consecutive pairs again, and this time keep the ones
  // whose gap actually clears the threshold — each one marks a real
  // column boundary. (Yes, this recomputes right - left, which was
  // already computed above for `gaps` — a small duplication, not a bug.)
  const boundaries: number[] = []
  for (let i = 1; i < sortedX.length; i++) {
    const left = sortedX[i - 1] ?? 0
    const right = sortedX[i] ?? 0
    if (right - left > gutterThreshold) {
      // Record the midpoint of the gutter itself, not either edge — a
      // line is classified by whichever side of the empty gutter space
      // it's closer to. columnIndexFor uses this against `line.minX`.
      boundaries.push((left + right) / 2)
    }
  }

  // Because sortedX is ascending and i only increases, any boundary found
  // later in the loop is always bigger than one found earlier — so
  // `boundaries` comes out already sorted left-to-right, with no
  // explicit sort needed here.
  return boundaries
}

// Given the boundaries found above, which column (0 = leftmost) a line
// falls into — just counting how many boundaries its left edge is past.
function columnIndexFor(line: Line, boundaries: number[]): number {
  let index = 0
  for (const boundary of boundaries) {
    if (line.minX >= boundary) index++
  }
  return index
}

function reorderForColumns(lines: Line[]): Line[] {
  const pages = [...new Set(lines.map((line) => line.page))].sort((a, b) => a - b)
  const result: Line[] = []

  for (const page of pages) {
    const pageLines = lines.filter((line) => line.page === page)
    const maxWidth = Math.max(...pageLines.map((line) => line.maxX - line.minX))

    const wide = new Set(pageLines.filter((line) => line.maxX - line.minX >= maxWidth * WIDE_LINE_WIDTH_FACTOR))
    const narrow = pageLines.filter((line) => !wide.has(line))

    // Nothing column-restricted on this page (or the page is essentially
    // one wide block) — original top-to-bottom order is already correct.
    if (narrow.length === 0) {
      result.push(...pageLines)
      continue
    }

    // However many real column boundaries exist on this page — not
    // assumed to be exactly one (i.e. not assumed to be exactly two
    // columns); could be zero, one, two, or more.
    const columnBoundaries = findColumnBoundaries(narrow)

    // Walk the page in original order, buffering consecutive narrow lines.
    // A wide line (or the end of the page) flushes the buffer: column 0's
    // lines first (top-to-bottom), then column 1's, then column 2's, etc.
    let buffer: Line[] = []
    const flushBuffer = () => {
      if (buffer.length === 0) return

      const columns: Line[][] = []
      for (const line of buffer) {
        const index = columnIndexFor(line, columnBoundaries)
        columns[index] ??= []
        columns[index].push(line)
      }

      for (const column of columns) {
        if (column) result.push(...column)
      }
      buffer = []
    }

    for (const line of pageLines) {
      if (wide.has(line)) {
        flushBuffer()
        result.push(line)
      } else {
        buffer.push(line)
      }
    }
    flushBuffer()
  }

  return result
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
  const orderedLines = reorderForColumns(lines)
  const paragraphs = groupIntoParagraphs(orderedLines)

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
