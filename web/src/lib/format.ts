/**
 * "2h ago" style timestamps.
 *
 * Only ever called from server components right now, so `Date.now()` runs on
 * the server and there's no hydration mismatch to worry about. If this is
 * ever needed inside a client component, the value should be passed down
 * already-formatted (or the component made client-only) rather than
 * recomputed on both sides.
 */
export function formatRelativeTime(isoTimestamp: string): string {
  const elapsedMs = Date.now() - new Date(isoTimestamp).getTime();

  // A timestamp in the future (clock skew, or seeded mock data) should read as
  // recent rather than as a negative duration.
  if (elapsedMs < 60_000) return "just now";

  const minutes = Math.round(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;

  return `${Math.round(months / 12)}y ago`;
}
