import type { Metadata } from "next";
import ProtectedOnboardingAcceptance from "./protected-onboarding-acceptance";

export const metadata: Metadata = {
  title: "Protected onboarding acceptance",
  description: "Complete the nonce-bound production onboarding acceptance journey.",
};

export default async function ProtectedOnboardingAcceptancePage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const query = await searchParams;
  const journeyId = typeof query.journey === "string" &&
      /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(query.journey)
    ? query.journey
    : null;
  return <ProtectedOnboardingAcceptance journeyId={journeyId} />;
}
