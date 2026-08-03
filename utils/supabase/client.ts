import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  const publicEnvironment = (
    import.meta as ImportMeta & {
      readonly env: Readonly<Record<string, string | undefined>>;
    }
  ).env;
  const supabaseUrl = publicEnvironment.NEXT_PUBLIC_SUPABASE_URL;
  const supabasePublishableKey =
    publicEnvironment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error("Supabase environment variables are not configured.");
  }

  return createBrowserClient(supabaseUrl, supabasePublishableKey);
}
