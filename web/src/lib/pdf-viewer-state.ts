export function clampPdfPage(
  requestedPage: number,
  totalPages: number,
): number | null {
  if (!Number.isFinite(requestedPage) || totalPages <= 0) return null;
  return Math.min(Math.max(Math.trunc(requestedPage), 1), totalPages);
}

export function changePdfZoom(
  currentZoom: number,
  direction: "in" | "out",
): number {
  const nextZoom = currentZoom + (direction === "in" ? 0.25 : -0.25);
  return Math.min(Math.max(nextZoom, 0.75), 2);
}
