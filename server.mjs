import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, sep, extname } from "node:path";
import { networkInterfaces } from "node:os";

const root = fileURLToPath(new URL("./public/", import.meta.url));
const port = Number(process.env.PORT ?? 5173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  try {
    const pathname = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname,
    );
    const path = resolve(
      root,
      `.${pathname === "/" ? "/index.html" : pathname}`,
    );
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const body = await readFile(path);
    response.writeHead(200, {
      "Content-Type": types[extname(path)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; style-src 'self'; script-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    const status =
      error.code === "ENOENT" || error.code === "EISDIR"
        ? 404
        : error instanceof URIError
          ? 400
          : 500;
    response
      .writeHead(status, { "Content-Type": "text/plain; charset=utf-8" })
      .end(status === 404 ? "Not found" : "Request failed");
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`H3VR ballistic calculator: http://127.0.0.1:${port}`);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses) {
      if (!address.internal && address.family === "IPv4") {
        console.log(`Network: http://${address.address}:${port}`);
      }
    }
  }
});
