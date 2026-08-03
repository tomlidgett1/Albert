import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

function safeNext(value: string | null): string {
  if (value === "/dash" || value === "/reset-password?mode=update") return value;
  return "/dash";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get("next"));
  if (!code) return NextResponse.redirect(new URL("/login?auth_error=missing_code", url));

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    return NextResponse.redirect(new URL(next, url));
  } catch {
    return NextResponse.redirect(new URL("/login?auth_error=expired_link", url));
  }
}
