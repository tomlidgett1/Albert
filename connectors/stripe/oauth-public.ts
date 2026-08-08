import { STRIPE_ALLOWED_SCOPES, STRIPE_DEFAULT_SCOPES } from "./manifest";

export type StripeAuthorizationUrlInput = Readonly<{
  clientId: string;
  state: string;
  redirectUri: string;
  scopes?: readonly string[];
}>;

/** Browser-safe authorization builder; never accepts a secret key. */
export function buildStripeAuthorizationUrl(input: StripeAuthorizationUrlInput): string {
  const scopes = input.scopes?.length ? input.scopes : STRIPE_DEFAULT_SCOPES;
  const unsupported = scopes.filter(
    (scope) => !STRIPE_ALLOWED_SCOPES.includes(scope as (typeof STRIPE_ALLOWED_SCOPES)[number]),
  );
  // Stripe's scope parameter is single valued; sending several would be
  // silently reinterpreted rather than rejected.
  if (
    !input.clientId || !input.state || !input.redirectUri ||
    unsupported.length > 0 || scopes.length !== 1
  ) {
    throw new Error("Invalid Stripe authorization parameters.");
  }
  const url = new URL("https://connect.stripe.com/oauth/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes[0]!);
  url.searchParams.set("state", input.state);
  url.searchParams.set("redirect_uri", input.redirectUri);
  return url.toString();
}
