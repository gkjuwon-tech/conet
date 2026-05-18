/**
 * pair-webserver — a tiny LAN-facing HTTP server that shows the active
 * pairing PIN to the device being claimed.
 *
 * The story:
 *   1. The user is on their laptop (this Electron app), pairing some
 *      headed device on their LAN — a smart TV, a fridge with a touch
 *      panel, an IoT console, whatever.
 *   2. The renderer mints a 6-digit PIN against the backend
 *      `/v1/devices/ownership/challenge` endpoint, and tells *this*
 *      webserver "for device IP X, the active PIN is N and expires
 *      at T".
 *   3. The user opens the device's own browser and visits one of our
 *      slugs — `http://<laptop-LAN-ip>:<port>/tv`, `/fridge`, `/pair`,
 *      etc. They're all the same handler. The server keys lookup by
 *      the *visiting* IP (which is the device itself), reads the
 *      stored PIN, and returns one giant HTML page with the digits.
 *   4. The user reads the PIN off the device's screen and types it
 *      back into the laptop UI.
 *
 * Why this beats the previous "backend pushes via vendor adapters"
 * approach: we don't need ADB on the backend host, we don't need LG
 * SSAP support, we don't have to guess vendor admin endpoints. We
 * only need the device to have a working web browser, which almost
 * every screened device on the market does. Devices without a screen
 * (router, smart plug, sensor) are intentionally NOT eligible for
 * pin_display — the renderer is supposed to route those to the
 * mac_serial method instead.
 *
 * Security model:
 *   - We bind to 0.0.0.0 but only serve on the LAN — the user is on
 *     a trusted Wi-Fi.
 *   - The page returned to a visiting IP only ever shows the PIN
 *     associated with *that* IP. A device on the LAN cannot enumerate
 *     other devices' PINs.
 *   - PINs auto-expire (5 minutes server-side; we mirror that here so
 *     we don't leak a stale PIN if the user lingers).
 *   - Anyone on the LAN who can spoof a device IP can read that
 *     device's PIN. This is the same trust boundary the rest of the
 *     LAN pairing flow already assumes.
 */

import http from "node:http";
import os from "node:os";

/** Default starting port. We fall through if it's already bound. */
const PRIMARY_PORT = 7777;
const FALLBACK_PORTS = [17777, 27777, 37777];

/**
 * Slugs all map to the same handler. We accept a handful of obvious
 * synonyms so a non-technical user typing what their device "is" still
 * lands on the right page.
 */
const PIN_SLUGS = new Set<string>([
  "/",
  "/pair",
  "/pin",
  "/code",
  "/tv",
  "/television",
  "/fridge",
  "/refridge", // user-requested typo-tolerant alias
  "/refrigerator",
  "/console",
  "/printer",
  "/iot",
  "/box",
  "/panel",
  "/screen",
  "/device",
]);

interface PinRecord {
  pin: string;
  expiresAtMs: number;
  deviceLabel?: string;
}

/** Keyed by normalized IPv4 string ("192.168.1.42"). */
const pins = new Map<string, PinRecord>();

let server: http.Server | null = null;
let bindHost = "0.0.0.0";
let boundPort = 0;
let lanIp: string | null = null;

export interface PairWebserverStatus {
  running: boolean;
  port: number | null;
  lanIp: string | null;
  baseUrl: string | null;
}

/** Strip IPv6 mapping and brackets from a raw socket address. */
function normalizeIp(raw: string | undefined): string {
  if (!raw) return "";
  let ip = raw;
  if (ip.startsWith("::ffff:")) ip = ip.slice("::ffff:".length);
  // [::1] etc — leave them; loopback won't ever match a real LAN IP.
  return ip;
}

/** Pick the most plausible LAN-facing IPv4 of this host. */
function detectLanIp(): string | null {
  const ifaces = os.networkInterfaces();
  const candidates: string[] = [];
  for (const name of Object.keys(ifaces)) {
    const addrs = ifaces[name];
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family !== "IPv4") continue;
      if (a.internal) continue;
      // Skip Docker / VPN / link-local ranges where we can.
      if (a.address.startsWith("169.254.")) continue;
      candidates.push(a.address);
    }
  }
  // Prefer RFC1918 ranges in order of "typical home network" likelihood.
  const order = ["192.168.", "10.", "172."];
  for (const prefix of order) {
    const hit = candidates.find((ip) => ip.startsWith(prefix));
    if (hit) return hit;
  }
  return candidates[0] ?? null;
}

function gcExpired(): void {
  const now = Date.now();
  for (const [ip, rec] of pins.entries()) {
    if (rec.expiresAtMs <= now) pins.delete(ip);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPinPage(opts: {
  pin: string;
  deviceLabel: string | undefined;
  expiresInSec: number;
}): string {
  const { pin, deviceLabel, expiresInSec } = opts;
  const labelLine = deviceLabel
    ? `<p class="label">${escapeHtml(deviceLabel)}</p>`
    : "";
  // Inline CSS — this page is served to a strange device that has no
  // access to our app bundle. We keep it cosmetically minimal but
  // legible from across a room.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>conet pairing PIN</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    background: #0A0B0A;
    color: #EAEAEA;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 24px;
    box-sizing: border-box;
  }
  main { max-width: 720px; width: 100%; }
  .eyebrow {
    color: #B6FF1A;
    letter-spacing: 0.24em;
    font-size: clamp(12px, 1.6vw, 16px);
    text-transform: uppercase;
    margin: 0 0 12px;
  }
  h1 { font-size: clamp(20px, 3vw, 32px); margin: 0 0 32px; font-weight: 500; }
  .label { color: #9AA09A; margin: -16px 0 24px; font-size: clamp(14px, 1.8vw, 18px); }
  .pin {
    font-size: clamp(72px, 22vw, 180px);
    letter-spacing: 0.18em;
    line-height: 1;
    margin: 0 0 24px;
    word-spacing: 0.1em;
    color: #FFFFFF;
  }
  .meta { color: #6E746E; font-size: clamp(12px, 1.4vw, 14px); margin: 0; }
  .meta strong { color: #B6FF1A; }
</style>
</head>
<body>
  <main>
    <p class="eyebrow">conet · pairing pin</p>
    <h1>Type this PIN on the computer you are pairing from</h1>
    ${labelLine}
    <p class="pin">${escapeHtml(pin)}</p>
    <p class="meta">Expires in <strong>${expiresInSec}s</strong>. Single-use.</p>
  </main>
</body>
</html>`;
}

function renderNoPinPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>conet · no active PIN</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    background: #0A0B0A;
    color: #EAEAEA;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 24px;
    box-sizing: border-box;
  }
  main { max-width: 640px; }
  h1 { font-size: clamp(20px, 3vw, 28px); margin: 0 0 16px; font-weight: 500; }
  p { color: #9AA09A; line-height: 1.5; margin: 0 0 12px; }
  code { color: #B6FF1A; }
</style>
</head>
<body>
  <main>
    <h1>No active pairing PIN for this device</h1>
    <p>Open the conet app on your computer and start a PIN pairing for this device first.</p>
    <p>Then refresh this page — try <code>/pair</code>, <code>/tv</code>, or <code>/fridge</code>.</p>
  </main>
</body>
</html>`;
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  // Method gating: only GET / HEAD. Anything else is misuse.
  const method = (req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end();
    return;
  }

  // Path normalization.
  const rawUrl = req.url || "/";
  const pathOnly = rawUrl.split("?")[0]!.split("#")[0]!.toLowerCase();
  const slug = pathOnly.endsWith("/") && pathOnly !== "/" ? pathOnly.slice(0, -1) : pathOnly;

  if (!PIN_SLUGS.has(slug)) {
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return;
  }

  gcExpired();

  const visitingIp = normalizeIp(req.socket.remoteAddress ?? undefined);
  const rec = pins.get(visitingIp);

  // Useful for debugging from the device's own dev console.
  res.setHeader("cache-control", "no-store");

  if (!rec) {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(renderNoPinPage());
    return;
  }

  const expiresInSec = Math.max(0, Math.floor((rec.expiresAtMs - Date.now()) / 1000));
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(
    renderPinPage({
      pin: rec.pin,
      deviceLabel: rec.deviceLabel,
      expiresInSec,
    })
  );
}

async function tryListen(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const s = http.createServer(handleRequest);
    s.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        resolve(false);
        return;
      }
      console.warn("[pair-webserver] listen error", { port, err: err.message });
      resolve(false);
    });
    s.listen(port, bindHost, () => {
      server = s;
      boundPort = port;
      resolve(true);
    });
  });
}

/** Start the LAN webserver. Idempotent — calling twice is a no-op. */
export async function startPairWebserver(): Promise<PairWebserverStatus> {
  if (server) return getStatus();

  lanIp = detectLanIp();

  const candidates = [PRIMARY_PORT, ...FALLBACK_PORTS];
  for (const port of candidates) {
    const ok = await tryListen(port);
    if (ok) {
      console.info("[pair-webserver] listening", { port, lanIp });
      return getStatus();
    }
  }
  console.warn("[pair-webserver] no port available", { tried: candidates });
  return getStatus();
}

/** Stop the LAN webserver. Idempotent. */
export async function stopPairWebserver(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  boundPort = 0;
  await new Promise<void>((resolve) => {
    s.close(() => resolve());
  });
}

/** Register a freshly-minted PIN for a device. Renderer calls this. */
export function registerPairingPin(opts: {
  deviceIp: string;
  pin: string;
  expiresAtIso: string;
  deviceLabel?: string;
}): void {
  const expiresAtMs = Date.parse(opts.expiresAtIso);
  if (Number.isNaN(expiresAtMs)) {
    console.warn("[pair-webserver] bad expiry", { iso: opts.expiresAtIso });
    return;
  }
  const ip = normalizeIp(opts.deviceIp);
  if (!ip) {
    console.warn("[pair-webserver] missing ip");
    return;
  }
  pins.set(ip, {
    pin: opts.pin,
    expiresAtMs,
    deviceLabel: opts.deviceLabel,
  });
  console.info("[pair-webserver] registered", {
    ip,
    expiresInSec: Math.floor((expiresAtMs - Date.now()) / 1000),
  });
}

/** Drop the PIN for one device (after verify / cancel). */
export function clearPairingPin(deviceIp: string): void {
  const ip = normalizeIp(deviceIp);
  if (!ip) return;
  pins.delete(ip);
}

export function getStatus(): PairWebserverStatus {
  const running = !!server && boundPort > 0;
  const baseUrl = running && lanIp ? `http://${lanIp}:${boundPort}` : null;
  return {
    running,
    port: boundPort || null,
    lanIp,
    baseUrl,
  };
}
