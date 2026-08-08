/**
 * Stand-in for a rendered first page.
 *
 * There are no stored PDFs to rasterise yet, so this draws a page-shaped SVG
 * whose text lines are derived from the document id. That keeps every card
 * visually distinct but perfectly stable between server and client renders —
 * no `Math.random()`, so nothing to mismatch on hydration.
 *
 * When real thumbnails land, this component is the only thing that needs to
 * change: swap the SVG for an <Image> pointed at the generated raster and the
 * grid above it carries on unchanged.
 */

/**
 * FNV-1a over the seed, then xorshift per value. Deterministic and cheap —
 * the point is stable variety, not statistical quality.
 */
function seededWidths(
  seed: string,
  count: number,
  min: number,
  max: number,
): number[] {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  const widths: number[] = [];
  for (let i = 0; i < count; i += 1) {
    hash = Math.imul(hash ^ (hash >>> 15), 2246822507);
    hash ^= hash >>> 13;
    const unit = ((hash >>> 0) % 1000) / 1000;
    widths.push(Math.round(min + unit * (max - min)));
  }
  return widths;
}

function Lines({
  x,
  y,
  widths,
  fill,
  height = 4,
  pitch = 11,
}: {
  x: number;
  y: number;
  widths: number[];
  fill: string;
  height?: number;
  pitch?: number;
}) {
  return (
    <>
      {widths.map((width, i) => (
        <rect
          key={i}
          x={x}
          y={y + i * pitch}
          width={width}
          height={height}
          rx={height / 2}
          fill={fill}
        />
      ))}
    </>
  );
}

export function PagePreview({
  seed,
  variant = "page",
}: {
  seed: string;
  /** "blank" for documents with no extracted text yet (indexing or failed). */
  variant?: "page" | "blank";
}) {
  // Deliberately monochrome: amber means provenance everywhere else in the
  // UI, and an unqueried page hasn't cited anything.
  const bodyOne = seededWidths(seed, 6, 130, 184);
  const bodyTwo = seededWidths(`${seed}-b`, 7, 120, 184);
  const titleWidths = seededWidths(`${seed}-t`, 2, 90, 160);

  return (
    <svg
      viewBox="0 0 240 320"
      className="block h-auto w-full"
      role="presentation"
    >
      <rect x="0" y="0" width="240" height="320" fill="var(--color-page)" />

      {variant === "page" && (
        <>
          <Lines
            x={28}
            y={34}
            widths={titleWidths}
            height={7}
            pitch={13}
            fill="var(--color-read)"
          />
          <Lines
            x={28}
            y={72}
            widths={[74]}
            height={4}
            fill="var(--color-graphite-dim)"
          />
          <rect
            x={28}
            y={90}
            width={184}
            height={1}
            fill="var(--color-rule-strong)"
          />

          <Lines
            x={28}
            y={104}
            widths={bodyOne}
            fill="var(--color-graphite-dim)"
          />
          <Lines
            x={28}
            y={186}
            widths={[64]}
            height={5}
            fill="var(--color-read)"
          />
          <Lines
            x={28}
            y={202}
            widths={bodyTwo}
            fill="var(--color-graphite-dim)"
          />
        </>
      )}
    </svg>
  );
}
