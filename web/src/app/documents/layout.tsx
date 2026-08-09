import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth-api";

/** This layout is the auth wrapper for every /documents page below it. */
export default async function DocumentsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return children;
}
