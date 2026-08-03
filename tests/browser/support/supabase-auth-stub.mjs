import { createHmac } from "node:crypto";
import { createServer } from "node:http";

const host = "127.0.0.1";
const port = 55_431;
const issuer = `http://${host}:${port}/auth/v1`;
const userId = "11111111-1111-4111-8111-111111111111";
const signingSecret = "albert-browser-acceptance-auth-signing-secret";

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function accessToken(email) {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    aal: "aal1",
    aud: "authenticated",
    email,
    exp: issuedAt + 3_600,
    iat: issuedAt,
    is_anonymous: false,
    iss: issuer,
    role: "authenticated",
    session_id: "22222222-2222-4222-8222-222222222222",
    sub: userId,
  }));
  const signature = createHmac("sha256", signingSecret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function user(email, metadata = {}) {
  const now = new Date().toISOString();
  return {
    id: userId,
    aud: "authenticated",
    role: "authenticated",
    email,
    email_confirmed_at: now,
    phone: "",
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: metadata,
    identities: [],
    created_at: now,
    updated_at: now,
    is_anonymous: false,
  };
}

function corsHeaders(request) {
  return {
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-origin": request.headers.origin ?? "http://127.0.0.1:3100",
    "access-control-expose-headers": "x-supabase-api-version",
    vary: "Origin",
  };
}

function json(response, request, status, body) {
  response.writeHead(status, {
    ...corsHeaders(request),
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-supabase-api-version": "2024-01-01",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders(request));
    response.end();
    return;
  }

  if (requestUrl.pathname === "/health") {
    json(response, request, 200, { status: "ok" });
    return;
  }

  if (requestUrl.pathname === "/auth/v1/token" && request.method === "POST") {
    const body = await readJson(request);
    const email = typeof body.email === "string" ? body.email : "owner@example.com";
    if (email === "invalid@example.com") {
      json(response, request, 400, {
        code: "invalid_credentials",
        msg: "Invalid login credentials",
      });
      return;
    }
    const token = accessToken(email);
    const authenticatedUser = user(email, {
      organisation_name: "Albert Bike Store",
      timezone: "Australia/Melbourne",
    });
    json(response, request, 200, {
      access_token: token,
      token_type: "bearer",
      expires_in: 3_600,
      expires_at: Math.floor(Date.now() / 1_000) + 3_600,
      refresh_token: "browser-acceptance-refresh-token",
      user: authenticatedUser,
    });
    return;
  }

  if (requestUrl.pathname === "/auth/v1/signup" && request.method === "POST") {
    const body = await readJson(request);
    const email = typeof body.email === "string" ? body.email : "new-owner@example.com";
    json(response, request, 200, user(email, body.data ?? {}));
    return;
  }

  if (requestUrl.pathname === "/auth/v1/user" && request.method === "GET") {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      json(response, request, 401, { code: "bad_jwt", msg: "Missing bearer token" });
      return;
    }
    json(response, request, 200, user("owner@example.com", {
      organisation_name: "Albert Bike Store",
      timezone: "Australia/Melbourne",
    }));
    return;
  }

  if (requestUrl.pathname === "/auth/v1/logout" && request.method === "POST") {
    response.writeHead(204, corsHeaders(request));
    response.end();
    return;
  }

  if (requestUrl.pathname === "/auth/v1/.well-known/jwks.json") {
    json(response, request, 200, { keys: [] });
    return;
  }

  json(response, request, 404, { code: "not_found", msg: "Auth fixture route not found" });
});

server.listen(port, host, () => {
  process.stdout.write(`Albert browser auth fixture listening on http://${host}:${port}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
