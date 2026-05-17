// Serves the conet phone-agent PWA on the local LAN and emits ready-to-tap
// pairing URLs (one per phone the user has already registered via
// `em lan pair-all`).
//
// Usage:
//   node electromesh-phone-agent/serve.mjs                   # auto-detects gateway IP
//   GATEWAY_IP=192.168.0.34 node electromesh-phone-agent/serve.mjs
//
// On the phone:
//   open the printed URL in Safari / Chrome → tap "Add to Home Screen" for PWA mode.
//   The page registers itself, attests, and starts pulling sha256 workunits
//   from the backend.

import http from "node:http";
import { URL as NodeURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DESIGN = path.resolve(__dirname, "..", "design");
const PORT = Number(process.env.PHONE_AGENT_PORT ?? 4877);
const BACKEND = process.env.EM_BACKEND ?? "http://localhost:8080";

function pickLanIp() {
  if (process.env.GATEWAY_IP) return process.env.GATEWAY_IP;
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === "IPv4" && !i.internal && /^192\.168\./.test(i.address)) {
        return i.address;
      }
    }
  }
  return "127.0.0.1";
}
const GATEWAY_IP = pickLanIp();
// We could give TVs/phones the BACKEND directly, but on Windows the
// 8080 inbound rule typically isn't open and adding one requires admin.
// Instead, we serve the PWA AND reverse-proxy /v1/* through 4877
// (Node.js binaries usually self-prompt for that port already). PWAs
// then talk to "same origin" with zero CORS surprises.
const BACKEND_LAN = `http://${GATEWAY_IP}:${PORT}`;

function loadUserToken() {
  // CLI state file path is unchanged — backend identity is still electromesh.
  const p = path.join(os.homedir(), ".electromesh", "state.json");
  if (!fs.existsSync(p)) {
    throw new Error(
      `not logged in to em CLI (no ${p}). Run \`em login\` first.`
    );
  }
  const s = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!s.userToken) throw new Error("no userToken in CLI state");
  return s.userToken;
}

const userToken = loadUserToken();

// Cache of the verified LAN claim fingerprint for this gateway user.
// Required by POST /v1/devices/register (hard gate against pairing on
// someone else's WiFi). Refreshed on startup and on demand.
let lanFingerprint = null;
async function refreshLanFingerprint() {
  try {
    const r = await fetch(`${BACKEND}/v1/lan-claims`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (!r.ok) {
      console.warn(`  [lan-fp] /v1/lan-claims responded ${r.status}`);
      return null;
    }
    const claims = await r.json();
    const verified = (Array.isArray(claims) ? claims : []).find(
      (c) => c.status === "verified" && c.is_active !== false
    );
    if (verified) {
      lanFingerprint = verified.lan_fingerprint;
      console.log(`  [lan-fp] using verified claim ${lanFingerprint?.slice(0, 16)}…`);
    } else {
      console.warn("  [lan-fp] no verified LanClaim found — auto-pair will fail with 403");
    }
    return lanFingerprint;
  } catch (e) {
    console.warn("  [lan-fp] refresh error:", e.message);
    return null;
  }
}

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
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp3":  "audio/mpeg",
  ".txt":  "text/plain; charset=utf-8",
};

function pickVendor(ua) {
  const s = (ua || "").toLowerCase();
  if (/iphone|ipad|ipod|safari.*mac os/.test(s)) return "Apple";
  if (/samsung|sm-/.test(s)) return "Samsung";
  if (/pixel|googletv|nexus/.test(s)) return "Google";
  if (/huawei/.test(s)) return "Huawei";
  if (/xiaomi|miui|redmi/.test(s)) return "Xiaomi";
  if (/oneplus/.test(s)) return "OnePlus";
  if (/lg/.test(s)) return "LG";
  if (/sony|bravia/.test(s)) return "Sony";
  return "Unknown";
}

function pickOs(ua) {
  const s = (ua || "").toLowerCase();
  if (/iphone os/.test(s)) {
    const m = s.match(/iphone os ([\d_]+)/);
    return m ? `iOS ${m[1].replace(/_/g, ".")}` : "iOS";
  }
  if (/android/.test(s)) {
    const m = s.match(/android ([\d.]+)/);
    return m ? `Android ${m[1]}` : "Android";
  }
  if (/tizen/.test(s)) return "Tizen";
  if (/webos/.test(s)) return "webOS";
  if (/windows nt/.test(s)) return "Windows";
  if (/mac os/.test(s)) return "macOS";
  if (/linux/.test(s)) return "Linux";
  return "unknown";
}

function pickDeviceClass(ua, hint = {}) {
  if (hint.deviceClass) return hint.deviceClass;
  const s = (ua || "").toLowerCase();
  if (/smarttv|tizen|webos|hbbtv|nettv|googletv|tv\b/.test(s)) return "smart_tv";
  if (/tablet|ipad/.test(s)) return "tablet";
  if (/playstation|xbox|nintendo/.test(s)) return "console";
  if (/iphone|android.*mobile|mobile.*safari|mobi\b/.test(s)) return "phone";
  if (/android/.test(s)) return "phone"; // android-tablet falls here too, close enough
  return "other_iot";
}

function labelFromUa(ua, ip) {
  const s = (ua || "").toLowerCase();
  if (/iphone/.test(s)) return `iPhone (${ip})`;
  if (/ipad/.test(s)) return `iPad (${ip})`;
  if (/sm-[a-z0-9-]+/.test(s)) {
    const m = s.match(/sm-[a-z0-9-]+/);
    return `Samsung ${m[0].toUpperCase()} (${ip})`;
  }
  if (/samsung|galaxy/.test(s)) return `Samsung phone (${ip})`;
  if (/pixel/.test(s)) return `Pixel (${ip})`;
  if (/android/.test(s)) return `Android (${ip})`;
  if (/tizen/.test(s)) return `Tizen TV (${ip})`;
  if (/webos/.test(s)) return `LG webOS TV (${ip})`;
  if (/tv/.test(s)) return `Smart TV (${ip})`;
  return `Device (${ip})`;
}

function safeJoin(base, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const resolved = path.normalize(path.join(base, decoded));
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

async function tryServe(filePath, res) {
  try {
    const s = await fs.promises.stat(filePath);
    if (!s.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const buf = await fs.promises.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

const indexHtmlPath = path.join(ROOT, "index.html");

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";

  // Basic CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

  // /v1/* → reverse-proxy to the real backend.
  // We use raw http.request instead of fetch() because undici's fetch is
  // strict about hop-by-hop headers (transfer-encoding, connection, etc.)
  // and keeps throwing "fetch failed" with no explanation when something
  // gets re-forwarded that it didn't like. Raw http.request just streams
  // bytes through, exactly the behaviour you want from a tiny proxy.
  if (url.startsWith("/v1/") || url === "/healthz") {
    proxyToBackend(req, res, url);
    return;
  }

  // /_auto_pair → zero-friction "I am a new device, claim me" endpoint.
  //
  // The gateway PC is the authority for this LAN (its userToken proves
  // LAN-claim ownership). When a phone / TV / fridge browser loads the
  // root PWA with no token, the page POSTs here exactly once. We create
  // a fresh device under the gateway user, issue a device-scoped token,
  // and return the full config blob. The PWA then starts mining
  // immediately — zero copy-paste, zero "open the link on the gateway",
  // zero QR code.
  //
  // The body is a tiny hint about the calling browser so we can pick a
  // sensible device label (e.g. "iPhone (192.168.0.54)"), but everything
  // is optional — the IP is enough.
  if (url === "/_auto_pair" && req.method === "POST") {
    try {
      let body = "";
      for await (const chunk of req) body += chunk.toString();
      const hint = body ? JSON.parse(body) : {};
      const remoteIp = (req.socket.remoteAddress || "")
        .replace(/^::ffff:/, "")
        .replace(/^::1$/, "127.0.0.1");
      const ua = String(req.headers["user-agent"] || "");
      const cls = pickDeviceClass(ua, hint);
      const label = hint.label || labelFromUa(ua, remoteIp);

      // Ensure we have the gateway user's verified LAN fingerprint.
      // The backend register endpoint hard-rejects without one.
      if (!lanFingerprint) await refreshLanFingerprint();
      if (!lanFingerprint) {
        res.writeHead(412, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "no_lan_claim",
          message: "Gateway user has no verified LAN claim. Run `em lan claim` on the PC first.",
        }));
        return;
      }

      // 1. Create device record under gateway user via /v1/devices/register.
      //    Matches the DeviceRegister schema (see backend/app/api/v1/devices.py:31).
      const createRes = await fetch(`${BACKEND}/v1/devices/register`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          label,
          device_class: cls,
          vendor: pickVendor(ua),
          model: ua.slice(0, 80),
          os: pickOs(ua),
          arch: hint.arch || "unknown",
          public_key: null,
          consents: {
            compute_share: true,
            network_share: true,
            storage_share: false,
            night_only: false,
            max_cpu_pct: 25,
            max_gpu_pct: 0,
            max_bandwidth_mbps: 5,
            blackout_hours: [],
          },
          capabilities: { sha256: true, argon2: false },
          lan_fingerprint: lanFingerprint,
        }),
      });
      if (!createRes.ok) {
        const t = await createRes.text();
        res.writeHead(createRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "create_failed", upstream: t.slice(0, 400) }));
        return;
      }
      const device = await createRes.json();

      // 2. Submit a placeholder benchmark so the device gets `idle` status
      //    (eligible for cluster bundling). Real numbers can be POSTed
      //    later by the PWA once it measures itself.
      await fetch(`${BACKEND}/v1/devices/${device.id}/benchmark`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          cpu_cores: hint.cores || 4,
          cpu_ghz: hint.ghz || 1.6,
          ram_mb: hint.ramMb || 4096,
          storage_gb: hint.storageGb || 64,
          cpu_gflops: 18,
          gpu_gflops: 0,
          hash_mhs_sha256: 3,
          hash_mhs_argon2: 0.001,
          network_mbps_down: 50,
          network_mbps_up: 20,
          network_latency_ms: 25,
          avg_idle_hours_per_day: 14,
        }),
      }).catch((e) => console.warn("  benchmark POST warn:", e.message));

      // 3. Issue a device token.
      const tokRes = await fetch(`${BACKEND}/v1/devices/${device.id}/issue-token`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      if (!tokRes.ok) {
        const t = await tokRes.text();
        res.writeHead(tokRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "issue_token_failed", upstream: t.slice(0, 400) }));
        return;
      }
      const tok = await tokRes.json();

      const cfg = {
        userToken,           // gateway user — needed for /v1/devices/* calls
        deviceToken: tok.token,
        deviceTokenExpiresAt: Date.now() + Math.max(60, (tok.expires_in || 3600) - 60) * 1000,
        deviceId: device.id,
        backend: BACKEND_LAN,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(cfg));
      console.log(`  ⚡ auto-pair  ${label}  →  device=${device.id.slice(0, 16)}…`);
    } catch (e) {
      console.error("  auto-pair error:", e);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
    return;
  }

  // /tv → big-buttons device picker, optimized for TV remotes.
  // Once you click a device the page builds the long /#token=…&device=…
  // pairing URL and navigates to it, so the TV browser only ever has to
  // type the short `IP:PORT/tv` address from the remote keyboard.
  if (url === "/tv" || url === "/tv/") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(renderTvPicker());
    return;
  }
  // /_devices → JSON list of browser-capable devices (used by /tv picker)
  if (url === "/_devices") {
    try {
      const r = await fetch(`${BACKEND}/v1/devices`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      if (!r.ok) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `HTTP ${r.status}` }));
        return;
      }
      const all = await r.json();
      const BROWSER_CAPABLE = new Set([
        "phone", "tablet", "smart_tv", "console", "fridge", "other_iot",
      ]);
      const list = all.filter(
        (d) =>
          BROWSER_CAPABLE.has(d.device_class) &&
          d.status !== "decommissioned" &&
          !/^vfleet-/.test(d.label || "")
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(list));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // /_pair?device=<id> → return the full pair-hash for that device id
  if (url.startsWith("/_pair?")) {
    const params = new URLSearchParams(url.split("?")[1]);
    const deviceId = params.get("device");
    if (!deviceId) {
      res.writeHead(400).end("missing device");
      return;
    }
    const hash = `token=${encodeURIComponent(userToken)}&device=${deviceId}&backend=${encodeURIComponent(BACKEND_LAN)}`;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hash }));
    return;
  }

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
  if (url === "/" || url.startsWith("/?") || url.startsWith("/#")) {
    if (await tryServe(indexHtmlPath, res)) return;
  }

  // exact files in this folder (sw.js, manifest.json, silent.mp3, etc.)
  const targetPath = safeJoin(ROOT, url);
  if (targetPath && (await tryServe(targetPath, res))) return;

  // SPA-ish fallback to index.html
  if (await tryServe(indexHtmlPath, res)) return;

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`\n  conet · phone-agent server`);
  console.log(`  PWA  : http://${GATEWAY_IP}:${PORT}`);
  console.log(`  API  : ${BACKEND_LAN}`);
  console.log(`\n  📺  TV-friendly picker (short, retroable URL):`);
  console.log(`        http://${GATEWAY_IP}:${PORT}/tv`);
  // Cache the verified LAN fingerprint up-front so /_auto_pair doesn't
  // have to do it on every cold request.
  await refreshLanFingerprint();
  await emitPairingUrls();
});

function proxyToBackend(req, res, url) {
  let target;
  try {
    target = new NodeURL(BACKEND.replace(/\/$/, "") + url);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "bad upstream url", message: e.message }));
    return;
  }
  // Forward only the headers we actually need. Specifically DROP:
  //   host (we replace), content-length (let node set it),
  //   connection / transfer-encoding / keep-alive / upgrade (hop-by-hop).
  const fwd = {};
  const allow = new Set([
    "authorization",
    "content-type",
    "accept",
    "user-agent",
    "x-api-key",
    "x-gateway-url",
  ]);
  for (const [k, v] of Object.entries(req.headers)) {
    if (allow.has(k.toLowerCase())) fwd[k] = v;
  }

  const opts = {
    method: req.method,
    hostname: target.hostname,
    port: target.port || 80,
    path: target.pathname + target.search,
    headers: fwd,
  };

  const upstream = http.request(opts, (upRes) => {
    res.writeHead(upRes.statusCode || 502, {
      ...upRes.headers,
      "Access-Control-Allow-Origin": "*",
    });
    upRes.pipe(res);
  });
  upstream.on("error", (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ error: "upstream", message: String(e.message || e) }));
  });
  // Stream the body straight through. http.request handles content-length.
  req.pipe(upstream);
}

function renderTvPicker() {
  // Self-contained, no external assets — works on the dumbest TV browsers.
  // Big tap targets (the TV remote's directional pad lands the focus ring
  // wherever; we want each card to be huge so missing is impossible).
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>conet · TV activator</title>
  <style>
    html, body { margin: 0; padding: 0; background: #0a0c0f; color: #f1f3f5; font-family: system-ui, sans-serif; }
    body { padding: 32px 48px; }
    h1 { font-size: 38px; margin: 0 0 8px 0; letter-spacing: -0.02em; }
    .sub { color: #8b94a0; font-size: 18px; margin-bottom: 32px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .card { background: #14181d; border: 2px solid #1f242b; border-radius: 16px; padding: 28px;
            cursor: pointer; transition: border-color .2s, transform .2s; outline: none; }
    .card:hover, .card:focus { border-color: #b6f25c; transform: translateY(-2px); }
    .card .ico { font-size: 56px; line-height: 1; }
    .card .nm { font-size: 26px; font-weight: 600; margin-top: 12px; }
    .card .meta { color: #8b94a0; font-size: 16px; margin-top: 4px; }
    .empty { font-size: 22px; color: #8b94a0; }
    .err { color: #f25c5c; }
    .status { position: fixed; left: 0; right: 0; bottom: 0; background: #14181d;
              padding: 18px 48px; font-size: 18px; color: #8b94a0; }
  </style>
</head>
<body>
  <h1>📺 conet · pick this device</h1>
  <p class="sub">Tap a card to activate that device's miner on this screen. The page will reload into the agent.</p>
  <div id="grid" class="grid"></div>
  <div class="status" id="status">loading devices…</div>
  <script>
    const ICON = { phone:"📱", tablet:"📲", smart_tv:"📺", console:"🎮", fridge:"🧊", other_iot:"🌐" };
    const status = document.getElementById("status");
    const grid = document.getElementById("grid");
    async function load() {
      const res = await fetch("/_devices");
      if (!res.ok) { grid.innerHTML = '<div class="empty err">failed to list devices</div>'; return; }
      const list = await res.json();
      if (!list.length) { grid.innerHTML = '<div class="empty">no browser-capable devices paired yet</div>'; status.textContent = "run em lan pair-all on your laptop"; return; }
      grid.innerHTML = "";
      for (const d of list) {
        const c = document.createElement("button");
        c.className = "card"; c.tabIndex = 0;
        c.innerHTML =
          '<div class="ico">' + (ICON[d.device_class] || "🌐") + '</div>' +
          '<div class="nm">' + escapeHtml(d.label || d.device_class) + '</div>' +
          '<div class="meta">' + d.device_class + ' · h100eq=' + (d.h100_equivalent || 0).toFixed(4) + ' · ' + d.status + '</div>';
        c.addEventListener("click", () => activate(d.id, d.label));
        grid.appendChild(c);
      }
      status.textContent = list.length + " device(s) — pick the one matching THIS screen";
      // focus the first card so the remote's center-button works immediately
      setTimeout(() => grid.firstChild && grid.firstChild.focus(), 50);
    }
    async function activate(id, label) {
      status.textContent = "activating " + label + "…";
      const res = await fetch("/_pair?device=" + encodeURIComponent(id));
      if (!res.ok) { status.textContent = "failed: HTTP " + res.status; return; }
      const { hash } = await res.json();
      location.replace("/#" + hash);
    }
    function escapeHtml(s) { return String(s||"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
    load().catch(e => { status.textContent = "error: " + e.message; });
  </script>
</body>
</html>`;
}

async function emitPairingUrls() {
  let devices = [];
  try {
    const res = await fetch(`${BACKEND}/v1/devices`, {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} listing devices`);
    }
    devices = await res.json();
  } catch (err) {
    console.error("  could not list devices:", err.message);
    return;
  }

  // Anything with a JS-capable browser can run this PWA — phone, tablet,
  // smart TV (Tizen / webOS / Android TV), set-top box, console with web
  // browser, even some smart fridges with their built-in WebKit. The PWA
  // does the same sha256 brute-forcing on whichever CPU loads it. We
  // exclude `vfleet-*` devices because those are already running as Node
  // Worker simulations on this laptop — duplicate-pairing them via a real
  // TV browser would just confuse the user.
  const BROWSER_CAPABLE = new Set([
    "phone", "tablet", "smart_tv", "console", "fridge", "other_iot",
  ]);
  const candidates = devices.filter(
    (d) =>
      BROWSER_CAPABLE.has(d.device_class) &&
      d.status !== "decommissioned" &&
      !/^vfleet-/.test(d.label || "")
  );

  if (candidates.length === 0) {
    console.log(`\n  (no browser-capable devices paired yet — run \`em lan pair-all\` first)\n`);
    return;
  }

  console.log(`\n  ${candidates.length} device(s) ready to activate via browser:\n`);
  for (const d of candidates) {
    const hash = `token=${encodeURIComponent(userToken)}&device=${d.id}&backend=${encodeURIComponent(BACKEND_LAN)}`;
    const url = `http://${GATEWAY_IP}:${PORT}/#${hash}`;
    const ico = d.device_class === "smart_tv" ? "📺" : d.device_class === "phone" ? "📱" : d.device_class === "tablet" ? "📲" : "🌐";
    console.log(`   ${ico}  ${d.label}`);
    console.log(`      ${d.device_class}  ·  id=${d.id.slice(0, 16)}…  ·  status=${d.status}`);
    console.log(`      → open this URL in the device's browser:`);
    console.log(`        ${url}\n`);
  }

  console.log(`   tip: TV browsers (Tizen / webOS) accept a typed URL — bookmark it`);
  console.log(`        once and the agent re-mines automatically every time you open it.\n`);
}
