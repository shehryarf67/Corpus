import { requireCurrentUser } from "@/lib/dal";

/** This layout is the auth wrapper for every /documents page below it. */
export default async function DocumentsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireCurrentUser();

  return children;
}
