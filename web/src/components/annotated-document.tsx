"use client";

import { useEffect, useRef } from "react";

/* ────────────────────────────────────────────────────────────
   Timeline. One cycle = a flip, then the annotation sequence.
   Two cycles make the full loop: the first flips on X, the second on Y.

   All times are ms and every stage is expressed as a plain start/end
   pair, so retiming the animation means changing a number here rather
   than recalculating keyframe percentages.
   ──────────────────────────────────────────────────────────── */
const CYCLE_MS = 10_000;
const TOTAL_MS = CYCLE_MS * 2;

const FLIP_END = 1_100;
const SWEEP_START = 1_400;
const SWEEP_END = 2_300;
const RULE_START = 1_400;
const RULE_END = 2_000;
const CONNECTOR_START = 2_800;
const CONNECTOR_END = 3_800;
const CHIP_START = 4_000;
const CHIP_END = 4_600;
const FADE_START = 8_200;
const FADE_END = 8_900;
/** Everything is transparent from FADE_END, so state snaps back unseen here. */
const RESET = 8_950;

const EASE_FLIP = "cubic-bezier(0.4, 0.1, 0.2, 1)";
/** Same easing the live passage highlight uses in the prototype. */
const EASE_SWEEP = "cubic-bezier(0.22, 1, 0.36, 1)";

/** Absolute position on the two-cycle loop, as a 0–1 keyframe offset. */
const at = (cycle: number, ms: number) => (cycle * CYCLE_MS + ms) / TOTAL_MS;

/** Same stage keyframes, emitted once per cycle. */
const eachCycle = (build: (cycle: number) => Keyframe[]): Keyframe[] => [
  ...build(0),
  ...build(1),
];

/**
 * The flips are the reason this is JS rather than CSS keyframes.
 *
 * A browser only interpolates the angle — producing a real spin — when both
 * ends of a segment use the *same* rotate function. Alternating axes inside
 * one animation means at least one segment straddles rotateX → rotateY, and
 * the fallback blend across that boundary renders as an unwanted extra
 * rotation. So each axis gets its own element and its own animation, and
 * neither ever mentions the other's function: no boundary, no stray spin.
 *
 * Both animations share TOTAL_MS and run off the browser's animation clock,
 * so they stay locked to each other and to the annotation stages without any
 * timers to drift.
 */
const flipKeyframes = (
  axis: "rotateX" | "rotateY",
  cycle: 0 | 1,
): Keyframe[] => {
  const spin: Keyframe[] = [
    { offset: at(cycle, 0), transform: `${axis}(0deg)`, easing: EASE_FLIP },
    { offset: at(cycle, FLIP_END), transform: `${axis}(360deg)` },
    { offset: 1, transform: `${axis}(360deg)` },
  ];
  // The Y layer has to sit still through the whole first cycle before its
  // turn, held with its own function so nothing blends across the wait.
  return cycle === 0
    ? spin
    : [{ offset: 0, transform: `${axis}(0deg)` }, ...spin];
};

const sweepKeyframes = eachCycle((c) => [
  { offset: at(c, 0), transform: "scaleX(0)", opacity: 1 },
  {
    offset: at(c, SWEEP_START),
    transform: "scaleX(0)",
    opacity: 1,
    easing: EASE_SWEEP,
  },
  { offset: at(c, SWEEP_END), transform: "scaleX(1)", opacity: 1 },
  { offset: at(c, FADE_START), transform: "scaleX(1)", opacity: 1 },
  { offset: at(c, FADE_END), transform: "scaleX(1)", opacity: 0 },
  // Shrink back while fully transparent, then restore opacity at zero
  // width — both invisible, so the reset never reads as motion.
  { offset: at(c, RESET), transform: "scaleX(0)", opacity: 0 },
  { offset: at(c, RESET + 10), transform: "scaleX(0)", opacity: 1 },
]);

const ruleKeyframes = eachCycle((c) => [
  { offset: at(c, 0), opacity: 0 },
  { offset: at(c, RULE_START), opacity: 0 },
  { offset: at(c, RULE_END), opacity: 1 },
  { offset: at(c, FADE_START), opacity: 1 },
  { offset: at(c, FADE_END), opacity: 0 },
]);

const connectorKeyframes = eachCycle((c) => [
  { offset: at(c, 0), strokeDashoffset: 1, opacity: 0 },
  { offset: at(c, CONNECTOR_START), strokeDashoffset: 1, opacity: 0 },
  { offset: at(c, CONNECTOR_START + 30), strokeDashoffset: 1, opacity: 1 },
  { offset: at(c, CONNECTOR_END), strokeDashoffset: 0, opacity: 1 },
  { offset: at(c, FADE_START), strokeDashoffset: 0, opacity: 1 },
  { offset: at(c, FADE_END), strokeDashoffset: 0, opacity: 0 },
  { offset: at(c, RESET), strokeDashoffset: 1, opacity: 0 },
]);

const chipKeyframes = eachCycle((c) => [
  { offset: at(c, 0), opacity: 0, transform: "translateY(5px)" },
  { offset: at(c, CHIP_START), opacity: 0, transform: "translateY(5px)" },
  { offset: at(c, CHIP_END), opacity: 1, transform: "translateY(0px)" },
  { offset: at(c, FADE_START), opacity: 1, transform: "translateY(0px)" },
  { offset: at(c, FADE_END), opacity: 0, transform: "translateY(0px)" },
  { offset: at(c, RESET), opacity: 0, transform: "translateY(5px)" },
]);

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
 * Decorative hero illustration for the auth screen: the page flips once,
 * then gets a passage highlighted, a connector drawn, and a citation chip
 * attached — the product's core loop, twice per 20s loop. The first pass
 * flips on the X-axis, the second on the Y-axis, then it repeats from X.
 *
 * The sequence runs on the Web Animations API rather than CSS keyframes
 * (see the timeline constants above for why). Every layer shares one
 * duration and runs off the browser's animation clock, so the stages stay
 * locked together with no timers to drift. prefers-reduced-motion skips
 * the effect entirely and CSS shows the finished composition instead.
 *
 * Each moving part needs its own element, because two animations can't
 * both drive `transform` on one node — the later one just wins:
 *   .doc-clip           contains the edge-on projection so it can't push
 *                       scrollbars onto the page (see globals.css)
 *     > .doc-float      ambient drift (left in CSS; needs no coordination)
 *       > .doc-perspective  static; inside the drift so the vanishing point
 *                           travels with the page
 *         > X layer     first cycle's flip
 *           > Y layer   second cycle's flip
 *             > svg     annotation layers fade independently inside
 */
export function AnnotatedDocument({ className }: { className?: string }) {
  const flipXRef = useRef<HTMLDivElement>(null);
  const flipYRef = useRef<HTMLDivElement>(null);
  const sweepRef = useRef<SVGRectElement>(null);
  const ruleRef = useRef<SVGRectElement>(null);
  const connectorRef = useRef<SVGPathElement>(null);
  const chipRef = useRef<SVGGElement>(null);

  useEffect(() => {
    // CSS already paints the finished state in this case; animating over
    // the top of it would defeat the point.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const layers: Array<[Element | null, Keyframe[]]> = [
      [flipXRef.current, flipKeyframes("rotateX", 0)],
      [flipYRef.current, flipKeyframes("rotateY", 1)],
      [sweepRef.current, sweepKeyframes],
      [ruleRef.current, ruleKeyframes],
      [connectorRef.current, connectorKeyframes],
      [chipRef.current, chipKeyframes],
    ];

    const animations = layers.flatMap(([element, keyframes]) =>
      element
        ? [
            element.animate(keyframes, {
              duration: TOTAL_MS,
              iterations: Infinity,
              // Per-keyframe easing does the shaping; a linear default
              // keeps every other segment a plain hold.
              easing: "linear",
            }),
          ]
        : [],
    );

    return () => animations.forEach((animation) => animation.cancel());
  }, []);

  return (
    <div className={className} aria-hidden="true">
      <div className="doc-clip">
        <div className="doc-float">
          <div className="doc-perspective">
            <div ref={flipXRef} className="doc-flip-layer">
              <div ref={flipYRef} className="doc-flip-layer">
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
                  <rect
                    x="60"
                    y="128"
                    width="200"
                    height="1"
                    fill="var(--color-rule)"
                  />

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
                    ref={sweepRef}
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
                    ref={ruleRef}
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
                    ref={connectorRef}
                    className="doc-connector"
                    d="M 268 264 C 292 264, 298 221, 322 221"
                    pathLength={1}
                    stroke="var(--color-marker-line)"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />

                  <g ref={chipRef} className="doc-chip">
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
          </div>
        </div>
      </div>
    </div>
  );
}
