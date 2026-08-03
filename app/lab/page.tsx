import { redirect } from "next/navigation";

/** The pre-production component lab is not exposed in the V1 product. */
export default function LabPage() {
  redirect("/dash");
}
