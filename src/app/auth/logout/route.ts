import { redirect } from "next/navigation";
import { endSession } from "@/lib/auth/session";

// POST only, so a cross-site <img src="/auth/logout"> cannot sign anyone out.
export async function POST() {
  await endSession();
  redirect("/");
}
