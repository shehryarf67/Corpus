import { redirect } from "next/navigation";

// No landing page yet — the app starts at auth. Once there's a real
// destination after sign-in (the workspace), this should redirect there
// instead when a session already exists.
export default function Home() {
  redirect("/login");
}
