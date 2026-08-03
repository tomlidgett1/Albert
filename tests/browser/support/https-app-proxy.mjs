import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

const host = "127.0.0.1";
const publicPort = 3_101;
const healthPort = 3_102;
const upstreamPort = 3_100;
const certificateDirectory = mkdtempSync(join(tmpdir(), "albert-browser-tls-"));
const certificatePath = join(certificateDirectory, "certificate.pem");
const keyPath = join(certificateDirectory, "key.pem");
const configPath = join(certificateDirectory, "openssl.cnf");

writeFileSync(configPath, [
  "[req]",
  "distinguished_name = subject",
  "x509_extensions = extensions",
  "prompt = no",
  "[subject]",
  "CN = 127.0.0.1",
  "[extensions]",
  "subjectAltName = IP:127.0.0.1",
].join("\n"));

execFileSync("openssl", [
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-sha256",
  "-nodes",
  "-days",
  "1",
  "-config",
  configPath,
  "-extensions",
  "extensions",
  "-keyout",
  keyPath,
  "-out",
  certificatePath,
], { stdio: "ignore" });

const proxy = createHttpsServer({
  cert: readFileSync(certificatePath),
  key: readFileSync(keyPath),
}, (request, response) => {
  const upstream = httpRequest({
    host,
    port: upstreamPort,
    method: request.method,
    path: request.url,
    headers: {
      ...request.headers,
      host: `${host}:${publicPort}`,
      "x-forwarded-host": `${host}:${publicPort}`,
      "x-forwarded-proto": "https",
    },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
    response.end("Albert production server is not ready.");
  });
  request.pipe(upstream);
});

const health = createHttpServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"status":"ok"}');
});

proxy.listen(publicPort, host, () => {
  process.stdout.write(`Albert browser HTTPS proxy listening on https://${host}:${publicPort}\n`);
});
health.listen(healthPort, host);

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  let remaining = 2;
  const finished = () => {
    remaining -= 1;
    if (remaining > 0) return;
    rmSync(certificateDirectory, { recursive: true, force: true });
    process.exit(0);
  };
  proxy.close(finished);
  health.close(finished);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
