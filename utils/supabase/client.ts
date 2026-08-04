import { createBrowserClient } from "@supabase/ssr";

function readBrowserPublicEnv(): {
  supabaseUrl: string | undefined;
  supabasePublishableKey: string | undefined;
} {
  // Vinext/Vite exposes public values on import.meta.env. Next/Vercel only
  // inlines statically referenced process.env.NEXT_PUBLIC_* keys, so keep both
  // access patterns explicit rather than dynamic lookups.
  const viteEnv = (
    import.meta as ImportMeta & {
      readonly env?: Readonly<Record<string, string | undefined>>;
    }
  ).env;

  return {
    supabaseUrl:
      viteEnv?.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
      process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(),
    supabasePublishableKey:
      viteEnv?.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ||
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim(),
  };
}

export function createClient() {
  const { supabaseUrl, supabasePublishableKey } = readBrowserPublicEnv();

  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error("Supabase environment variables are not configured.");
  }

  return createBrowserClient(supabaseUrl, supabasePublishableKey);
}
