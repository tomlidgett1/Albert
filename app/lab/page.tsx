import { Suspense } from "react";
import { connection } from "next/server";
import { redirect } from "next/navigation";

async function RedirectToDash(): Promise<never> {
  await connection();
  redirect("/dash");
}

/** The pre-production component lab is not exposed in the V1 product. */
export default function LabPage() {
  return (
    <Suspense fallback={null}>
      <RedirectToDash />
    </Suspense>
  );
}
