type TextLinesProps = {
  x: number;
  y: number;
  widths: number[];
  fill: string;
  height?: number;
  pitch?: number;
};

// Rows of "text" as rounded bars. Widths are given per line so paragraphs get
// a ragged right edge instead of looking like a solid block.
function TextLines({
  x,
  y,
  widths,
  fill,
  height = 5,
  pitch = 14,
}: TextLinesProps) {
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

/**
 * Decorative hero illustration for the auth screen: the page turns over, then
 * gets a passage highlighted, a connector drawn, and a citation chip attached
 * — the product's core loop, on a repeating 10s timeline.
 *
 * Motion is pure CSS (see globals.css). Every step shares the same duration
 * and is sequenced by keyframe percentages, so the stages stay in lockstep
 * without any JS timers. Honours prefers-reduced-motion by jumping to the
 * finished state.
 *
 * The drift and the flip live on separate elements on purpose: two animations
 * can't both drive `transform` on one node — the later one would simply win.
 */
export function AnnotatedDocument({ className }: { className?: string }) {
  return (
    <div className={className} aria-hidden="true">
      <div className="doc-float">
        <svg
          viewBox="0 0 420 440"
          fill="none"
          className="h-auto w-full drop-shadow-[0_26px_64px_rgba(0,0,0,0.55)]"
        >
          {/* the page */}
          <rect
            x="20"
            y="24"
            width="280"
            height="392"
            rx="3"
            fill="var(--color-page)"
            stroke="var(--color-rule)"
          />

          {/* title + byline */}
          <TextLines
            x={60}
            y={62}
            widths={[172, 116]}
            height={7}
            pitch={16}
            fill="var(--color-read)"
          />
          <TextLines
            x={60}
            y={106}
            widths={[128]}
            fill="var(--color-graphite-dim)"
          />
          <rect x="60" y="128" width="200" height="1" fill="var(--color-rule)" />

          <TextLines
            x={60}
            y={148}
            widths={[200, 192, 200, 154]}
            fill="var(--color-graphite-dim)"
          />

          {/* section heading */}
          <TextLines
            x={60}
            y={218}
            widths={[88]}
            height={6}
            fill="var(--color-read)"
          />

          {/* ── the cited passage ─────────────────────────────── */}
          {/* Highlighter ink. Sweeps left→right, matching how a live passage
              lights up in the app. */}
          <rect
            className="doc-sweep"
            x="52"
            y="240"
            width="216"
            height="48"
            rx="2"
            fill="var(--color-marker-soft)"
          />
          {/* Margin rule — the product marks any cited paragraph this way. */}
          <rect
            className="doc-rule"
            x="48"
            y="242"
            width="2"
            height="44"
            fill="var(--color-marker-line)"
          />
          <TextLines
            x={60}
            y={250}
            widths={[196, 200, 138]}
            fill="var(--color-read)"
          />

          <TextLines
            x={60}
            y={312}
            widths={[200, 176, 200, 190, 132]}
            fill="var(--color-graphite-dim)"
          />

          <rect
            x="155"
            y="396"
            width="10"
            height="4"
            rx="2"
            fill="var(--color-graphite-dim)"
          />

          {/* ── the citation ──────────────────────────────────── */}
          {/* pathLength=1 normalises the curve so the dash animation works
              regardless of its actual measured length. */}
          <path
            className="doc-connector"
            d="M 268 264 C 292 264, 298 221, 322 221"
            pathLength={1}
            stroke="var(--color-marker-line)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />

          <g className="doc-chip">
            <rect
              x="322"
              y="208"
              width="66"
              height="26"
              rx="3"
              fill="var(--color-marker-soft)"
            />
            {/* Bottom hairline echoes the .cite underline used in answers. */}
            <rect
              x="322"
              y="232"
              width="66"
              height="1.5"
              fill="var(--color-marker-line)"
            />
            <text
              x="355"
              y="222"
              textAnchor="middle"
              dominantBaseline="middle"
              className="font-mono"
              fontSize="11"
              letterSpacing="0.08em"
              fill="var(--color-marker)"
            >
              c07
            </text>
          </g>
        </svg>
      </div>
    </div>
  );
}
