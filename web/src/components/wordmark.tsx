// Used on the auth screen and (later) the workspace topbar. The mark is three
// lines of "text" with the middle one highlighted amber — the same provenance
// idea the rest of the interface runs on.
export function Wordmark() {
  return (
    <div className="flex items-center gap-[9px]">
      <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true">
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
      <span className="text-[14.5px] font-semibold tracking-[-0.015em]">Corpus</span>
    </div>
  );
}
