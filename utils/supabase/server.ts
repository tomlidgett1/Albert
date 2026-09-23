import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { assertRuntimeEnvironment } from "../../packages/config/src/env";
import { bearerAccessToken } from "./bearer";

/**
 * The access token an API client presented on this request, if any (ADR 0144).
 * A bearer request is authenticated by that token alone: its cookies are never
 * read, so the two credential paths cannot mix.
 */
export async function requestBearerAccessToken(): Promise<string | null> {
  return bearerAccessToken((await headers()).get("authorization"));
}

export async function createClient(): Promise<SupabaseClient> {
  assertRuntimeEnvironment("web");
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabasePublishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error("Supabase environment variables are not configured.");
  }

  const accessToken = await requestBearerAccessToken();
  if (accessToken) {
    // Every RPC runs under the token's own user policies, exactly as it would
    // for a browser session. There is nothing to persist or refresh: the
    // client mints a fresh token before this one expires.
    return createSupabaseClient(supabaseUrl, supabasePublishableKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }

  const cookieStore = await cookies();
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
