// Embedded phone-agent HTTP server.
//
// Hosts the ElectroMesh PWA on the LAN so phones / tablets on the same Wi-Fi
// can open a single URL, install the PWA to the Home Screen, and start
// pulling real sha256 / argon2 work from the backend on their own CPU —
// in the background, even with the browser closed.
//
// V2 changes:
//   * Serves index.html, sw.js, manifest.json, and a tiny silent-audio MP3
//     used by the in-page background-keepalive trick.
//   * Sends correct MIME types so the SW registers (browsers refuse SWs
//     served as text/html).
//   * Sends a Service-Worker-Allowed header so the SW scope is "/".
//   * Adds a /healthz endpoint so the consumer UI can verify the server is up.
//
// The PWA itself lives under `electromesh-phone-agent/` so the production
// binary, the dev runner, and the standalone CLI server all share one source
// of truth.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 4877;

interface PhoneAgentStatus {
  ready: boolean;
  gatewayIp: string;
  port: number;
  pwaUrl: string;
  error?: string;
}

let status: PhoneAgentStatus = {
  ready: false,
  gatewayIp: "127.0.0.1",
  port: PORT,
  pwaUrl: ""
};

function pickLanIp(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] ?? []) {
      if (i.family === "IPv4" && !i.internal && /^192\.168\./.test(i.address)) {
        return i.address;
      }
    }
  }
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] ?? []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "127.0.0.1";
}

function locatePwaDir(): string {
  const candidates = [
    path.join(__dirname, "..", "..", "..", "electromesh-phone-agent"),
    path.join(process.cwd(), "..", "electromesh-phone-agent"),
    path.join(process.resourcesPath ?? "", "phone-agent"),
    path.join(process.cwd(), "electromesh-phone-agent")
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "index.html"))) return c;
    } catch {
      /* continue */
    }
  }
  return candidates[0];
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/manifest+json; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".mp3":  "audio/mpeg",
  ".ico":  "image/x-icon"
};

// 1-second silent MP3 (constant), used for the in-page audio-keepalive trick.
// Decoded at runtime so we don't ship a binary asset.
const SILENT_MP3_B64 =
  "//OAxAAAAAAAAAAAAFhpbmcAAAAPAAAAAwAACgYAAEhISEhISEhISEhISEhISEhISEhISEhISEhI" +
  "SEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhI" +
  "SEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhI";

export function getPhoneAgentStatus(): PhoneAgentStatus {
  return status;
}

export function buildPairingUrl(opts: {
  userToken: string;
  deviceId: string;
  backendUrl: string;
}): string {
  const hash = `token=${encodeURIComponent(opts.userToken)}` +
    `&device=${encodeURIComponent(opts.deviceId)}` +
    `&backend=${encodeURIComponent(opts.backendUrl)}`;
  return `${status.pwaUrl}/#${hash}`;
}

function serveStatic(pwaDir: string, urlPath: string): {
  body: Buffer;
  type: string;
} | null {
  // Sanitize: only allow files within pwaDir, no path-traversal.
  const safe = urlPath.replace(/\?.*$/, "").replace(/^\/+/, "");
  const candidate = safe === "" ? "index.html" : safe;
  const full = path.normalize(path.join(pwaDir, candidate));
  if (!full.startsWith(path.normalize(pwaDir))) return null;
  try {
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    const ext = path.extname(full).toLowerCase();
    return { body: fs.readFileSync(full), type: MIME[ext] ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

export async function startPhoneAgentServer(): Promise<PhoneAgentStatus> {
  const pwaDir = locatePwaDir();
  if (!fs.existsSync(path.join(pwaDir, "index.html"))) {
    status.ready = false;
    status.error = `PWA index.html not found in ${pwaDir}`;
    console.error("[phone-agent]", status.error);
    return status;
  }

  const gatewayIp = pickLanIp();

  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    // Required so a SW served from /sw.js can claim scope "/".
    res.setHeader("Service-Worker-Allowed", "/");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const url = req.url ?? "/";

    // Synthetic endpoints --------------------------------------------------
    if (url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, pwa: pwaDir }));
      return;
    }
    if (url === "/silent.mp3") {
      const buf = Buffer.from(SILENT_MP3_B64, "base64");
      res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(buf.length),
        "Cache-Control": "public, max-age=31536000"
      });
      res.end(buf);
      return;
    }

    // Static file serving --------------------------------------------------
    const file = serveStatic(pwaDir, url === "/" ? "/index.html" : url);
    if (!file) {
      // SPA-style fallback: any unmatched route returns index.html.
      const indexFile = serveStatic(pwaDir, "/index.html");
      if (!indexFile) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": indexFile.type, "Cache-Control": "no-store" });
      res.end(indexFile.body);
      return;
    }
    res.writeHead(200, {
      "Content-Type": file.type,
      "Cache-Control": url.endsWith("/sw.js") ? "no-store, max-age=0" : "no-store"
    });
    res.end(file.body);
  });

  return await new Promise((resolve) => {
    server.once("error", (err) => {
      status = {
        ready: false,
        gatewayIp,
        port: PORT,
        pwaUrl: "",
        error: err.message
      };
      console.error("[phone-agent] failed to bind", PORT, err.message);
      resolve(status);
    });
    server.listen(PORT, "0.0.0.0", () => {
      status = {
        ready: true,
        gatewayIp,
        port: PORT,
        pwaUrl: `http://${gatewayIp}:${PORT}`
      };
      console.log("[phone-agent] PWA online at", status.pwaUrl);
      resolve(status);
    });
  });
}
