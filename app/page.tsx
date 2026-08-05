import { Suspense } from "react";
import { connection } from "next/server";
import { redirect } from "next/navigation";

async function RedirectToLogin(): Promise<never> {
  await connection();
  redirect("/login");
}

/** Albert V1 is an authenticated product; the public root has no demo shell. */
export default function Home() {
  return (
    <Suspense fallback={null}>
      <RedirectToLogin />
    </Suspense>
  );
}
