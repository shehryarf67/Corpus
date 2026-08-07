type CorpusMarkProps = {
  size?: number;
  className?: string;
};

/**
 * The Corpus glyph: a document with three lines, the middle one highlighted
 * amber. That's the whole product in one shape — an answer, and the passage
 * it came from.
 *
 * Colours are CSS variables so the mark tracks the theme. The standalone
 * browser-tab version lives in `app/icon.svg` and has to hard-code the same
 * hex values, since a favicon renders outside the page and can't read them.
 */
export function CorpusMark({ size = 17, className }: CorpusMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 17 17"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <rect
        x=".5"
        y=".5"
        width="16"
        height="16"
        rx="2"
        stroke="var(--color-graphite-dim)"
      />
      <rect x="4" y="4.5" width="9" height="1.4" fill="var(--color-graphite)" />
      <rect x="4" y="7.8" width="9" height="1.4" fill="var(--color-marker)" />
      <rect x="4" y="11.1" width="6" height="1.4" fill="var(--color-graphite)" />
    </svg>
  );
}
