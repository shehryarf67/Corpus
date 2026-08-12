"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const STATUS_REFRESH_INTERVAL_MS = 2000;

export function DocumentStatusRefresher({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    // There is nothing to poll once every ingestion job has finished or
    // failed, so avoid making permanent background requests.
    if (!active) return;

    const intervalId = window.setInterval(() => {
      // The page is a Server Component. Refreshing makes it call
      // GET /documents again and render the worker's latest job statuses.
      router.refresh();
    }, STATUS_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [active, router]);

  // This component controls refreshing only and has no visible UI.
  return null;
}
