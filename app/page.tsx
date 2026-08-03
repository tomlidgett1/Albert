import { redirect } from "next/navigation";

/** Albert V1 is an authenticated product; the public root has no demo shell. */
export default function Home() {
  redirect("/login");
}
