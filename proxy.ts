import type { NextRequest } from "next/server";
import { updateSession } from "@/utils/supabase/proxy";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: ["/dash/:path*", "/view2", "/newagent", "/login", "/reset-password", "/auth/:path*"],
};
