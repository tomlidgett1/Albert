import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { assertRuntimeEnvironment } from "../../packages/config/src/env";

export async function createClient() {
  assertRuntimeEnvironment("web");
  const cookieStore = await cookies();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabasePublishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error("Supabase environment variables are not configured.");
  }

  return createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Components cannot write cookies. The session proxy refreshes
          // them before rendering, while Server Actions can write them normally.
        }
      },
    },
  });
}
