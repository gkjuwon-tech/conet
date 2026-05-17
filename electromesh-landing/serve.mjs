// conet · landing static server
//
// Serves the landing index.html at / and exposes the workspace-level
// `design/` directory at /design/* so that the landing's <link rel="stylesheet"
// href="/design/...css"> tags resolve without a build step.
//
// Run with `node serve.mjs` (or `npm run dev` from this folder).

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DESIGN = path.resolve(__dirname, "..", "design");
const PORT = Number(process.env.PORT ?? 4090);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf":  "font/ttf",
  ".otf":  "font/otf",
  ".txt":  "text/plain; charset=utf-8",
  ".map":  "application/json; charset=utf-8",
};

function safeJoin(base, urlPath) {
  // strip query string + decode + collapse
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const resolved = path.normalize(path.join(base, decoded));
  // disallow path traversal
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

async function tryServe(filePath, res) {
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) {
      const indexFile = path.join(filePath, "index.html");
      const idx = await stat(indexFile);
      if (idx.isFile()) return tryServe(indexFile, res);
      return false;
    }
    if (!s.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const buf = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";

  // /design/* → workspace design folder
  if (url.startsWith("/design/")) {
    const rel = url.slice("/design/".length);
    const target = safeJoin(DESIGN, rel);
    if (target && (await tryServe(target, res))) return;
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found in design/");
    return;
  }

  // root → index.html
  const targetPath = url === "/" ? path.join(ROOT, "index.html") : safeJoin(ROOT, url);
  if (targetPath && (await tryServe(targetPath, res))) return;

  // SPA-ish fallback to index.html
  if (await tryServe(path.join(ROOT, "index.html"), res)) return;

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`\n  conet · landing\n  http://localhost:${PORT}\n`);
});
