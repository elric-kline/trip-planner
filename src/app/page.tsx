import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth.ts";

export default async function HomePage() {
  const user = await getCurrentUser();
  redirect(user ? "/trips" : "/login");
}
