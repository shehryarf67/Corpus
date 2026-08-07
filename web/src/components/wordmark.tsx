import { CorpusMark } from "./corpus-mark";

// Mark plus name. Used on the auth screen and (later) the workspace topbar.
export function Wordmark() {
  return (
    <div className="flex items-center gap-[9px]">
      <CorpusMark />
      <span className="text-[14.5px] font-semibold tracking-[-0.015em]">Corpus</span>
    </div>
  );
}
