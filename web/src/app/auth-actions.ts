"use server";

import { redirect } from "next/navigation";
import { logout } from "@/lib/auth-api";

export async function logoutAction(): Promise<void> {
  await logout();
  redirect("/login");
}
