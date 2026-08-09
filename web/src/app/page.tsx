import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/dal";

// Send each visitor to the correct side of the authentication boundary.
export default async function Home() {
  const user = await getCurrentUser();
  redirect(user ? "/documents" : "/login");
}
