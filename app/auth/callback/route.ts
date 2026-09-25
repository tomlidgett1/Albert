import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { safeDashboardRedirect } from "@/app/login/safe-redirect";

function safeNext(value: string | null, origin: string): string {
  if (value === "/dash" || value === "/reset-password?mode=update") return value;
  return safeDashboardRedirect(value, origin);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  if (tokenHash && type) {
    const recover = new URL("/auth/recover", url.origin);
    recover.searchParams.set("token_hash", tokenHash);
    recover.searchParams.set("type", type);
    return NextResponse.redirect(recover);
  }

  const errorCode = url.searchParams.get("error_code") ?? url.searchParams.get("error");
  if (errorCode) {
    return NextResponse.redirect(new URL("/login?auth_error=expired_link", url.origin));
  }

  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get("next"), url.origin);
  if (!code) return NextResponse.redirect(new URL("/login?auth_error=expired_link", url.origin));

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    return NextResponse.redirect(new URL(next, url.origin));
  } catch {
    return NextResponse.redirect(new URL("/login?auth_error=expired_link", url.origin));
  }
}
