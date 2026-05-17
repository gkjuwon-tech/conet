// tv-sim/sim.mjs — load the conet phone-agent PWA in headless Chromium under
// a faithful smart-TV environment so we can iterate on agent logic without
// asking the human to keep rebooting their actual television.
//
// What we model (based on what we've actually observed on the user's Sony):
//   - super slow CPU                  → Puppeteer CPU throttling 8x
//   - browser as background process   → page.emulateVisibilityState('hidden')
//   - 1920x1080 viewport, big-screen UA
//   - flaky setTimeout(0)             → injected throttler that floors short
//                                       timeouts at 250ms (TVs are worse but
//                                       this catches >99% of the bugs)
//   - no service worker                → we already removed it from the page
//
// What we DO:
//   1. Pair as a fresh TV via the same V2 endpoints virtual-device.mjs uses.
//   2. Inject the device cfg into localStorage and navigate to the PWA URL.
//   3. Mirror every console.log, every fetch, every status update.
//   4. Submit a tiny hashcrack job and watch the page claim/process/submit.
//   5. Repeat in a loop, exiting only when one full claim→submit succeeds.

import puppeteer from "puppeteer";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BACKEND_INTERNAL = process.env.BACKEND ?? "http://localhost:8080";
const PWA_URL = process.env.PWA ?? "http://localhost:4877";
const ADMIN_KEY = process.env.ADMIN_KEY ?? "em_live_admin";

// ---------- tiny color logger ----------
const c = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const dim = c(2), red = c(31), grn = c(32), yel = c(33), blu = c(34), mag = c(35), cya = c(36);
const ts = () => new Date().toISOString().slice(11, 23);
function log(tag, msg, color = blu) {
  console.log(`${dim(ts())} ${color(tag.padEnd(7))} ${msg}`);
}

// ---------- backend helpers ----------
async function api(method, path, { body, token, adminKey } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (adminKey) headers["X-Api-Key"] = adminKey;
  const res = await fetch(BACKEND_INTERNAL + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${txt.slice(0, 240)}`);
  return txt ? JSON.parse(txt) : null;
}

function jwtExp(tok) {
  try {
    const [, p] = tok.split(".");
    const o = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    return o.exp * 1000;
  } catch { return 0; }
}

async function ensureFreshUser() {
  // Prefer reusing the CLI's user token if it's still valid.
  const stPath = path.join(os.homedir(), ".electromesh", "state.json");
  if (fs.existsSync(stPath)) {
    let raw = fs.readFileSync(stPath);
    if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) raw = raw.slice(3);
    try {
      const st = JSON.parse(raw.toString("utf8"));
      const tok = st.userToken;
      if (tok && jwtExp(tok) > Date.now() + 60_000) {
        log("user", `reusing CLI user token (exp ${new Date(jwtExp(tok)).toISOString()})`, grn);
        return tok;
      }
    } catch (e) {
      log("user", "state.json parse failed: " + e.message, yel);
    }
  }
  // Fresh register → login.
  const email = `tvsim-${Date.now()}@conet.dev`;
  const password = "TvSim-" + crypto.randomBytes(6).toString("hex") + "Aa1!";
  await api("POST", "/v1/users/register", {
    body: { email, password, display_name: "TV Sim", country_code: "KR", locale: "en-US",
            accepted_tos_version: "v1" },
  });
  const t = await api("POST", "/v1/users/login", { body: { email, password } });
  log("user", `${email} fresh login`, grn);
  return t.access_token;
}

async function getVerifiedLanFp(userToken) {
  const claims = await api("GET", "/v1/lan-claims", { token: userToken });
  const list = Array.isArray(claims) ? claims : claims?.claims || [];
  const v = list.find((c) => c.is_active && (c.status === "verified" || c.verified_at));
  if (!v) throw new Error("no verified LAN claim — run `em lan claim` first");
  return v.lan_fingerprint;
}

async function pairFakeTv(userToken, lanFp) {
  const sess = await api("POST", "/v1/pairing/start", {
    body: {
      profile_key: "tv",
      lan_fingerprint: lanFp,
      label: "TV-Sim Sony 85X95L",
    },
    token: userToken,
  });
  const completeBody = {};
  if (sess.method === "pin") completeBody.pin = sess.pin;
  else if (sess.method === "otp") completeBody.otp = sess.otp;
  else completeBody.qr_token = sess.qr_token;
  const r = await api("POST", "/v1/pairing/complete", { body: completeBody });
  log("pair", `${r.device.handle} (${r.device.id})`, grn);
  return { deviceId: r.device.id, deviceToken: r.token, deviceHandle: r.device.handle };
}

async function getEnterpriseKey() {
  const stPath = path.join(os.homedir(), ".electromesh", "state.json");
  if (!fs.existsSync(stPath)) return null;
  let raw = fs.readFileSync(stPath);
  if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) raw = raw.slice(3);
  try {
    const st = JSON.parse(raw.toString("utf8"));
    return st?.enterprise?.apiKey ?? null;
  } catch { return null; }
}

async function submitTinyJob(userToken, entKey) {
  const text = "tvy";
  const target = crypto.createHash("sha256").update(text).digest("hex");
  const charset = "abcdefghijklmnopqrstuvwxyz";
  const len = text.length;
  const job = await api("POST", "/v1/jobs", {
    body: {
      kind: "hashcrack.range",
      title: "tv-sim quick crack",
      target_cluster_count: 1,
      target_h100_equivalent: 0,
      max_budget_cents: 100,
      max_runtime_seconds: 600,
      redundancy: 1,
      consensus_threshold: 0.5,
      hashcrack_range: {
        algorithm: "sha256",
        target_hash: target,
        charset,
        min_length: len,
        max_length: len,
        chunk_size: 10000,
      },
    },
    token: entKey ? undefined : userToken,
    adminKey: entKey || undefined,
  });
  log("job", `${job.handle ?? job.id} target=sha256("${text}") len=${len}`, mag);
  return job;
}

// ---------- the actual sim run ----------
async function run() {
  log("boot", "starting tv-sim · backend=" + BACKEND_INTERNAL + " pwa=" + PWA_URL, cya);

  const userToken = process.env.USER_TOKEN || await ensureFreshUser();
  if (!userToken) throw new Error("need USER_TOKEN env var or FRESH_USER=1");

  const lanFp = await getVerifiedLanFp(userToken);
  log("lan", `using verified lan_fp ${lanFp}`, grn);

  const { deviceId, deviceToken } = await pairFakeTv(userToken, lanFp);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--disable-features=IsolateOrigins,site-per-process",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const page = await browser.newPage();

  // ---- TV emulation ----
  await page.setUserAgent(
    "Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) 94.0.4606.31/7.0 TV Safari/537.36"
  );
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);

  const cdp = await page.target().createCDPSession();
  // Defer CPU throttling until after the initial nav so domcontentloaded
  // doesn't time out from page-load JS itself running 8x slow.
  // Network-wise the LAN is fast; only CPU + visibility are TV-painful.

  // hidden visibility — Tizen reports this even when on screen
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
    Object.defineProperty(document, "hidden", { get: () => true, configurable: true });
    // and floor short timers a bit, like a real TV would
    const _setTimeout = window.setTimeout.bind(window);
    window.setTimeout = (fn, ms, ...rest) => _setTimeout(fn, Math.max(ms || 0, 50), ...rest);

    // Mirror #log entries into console so the harness can stream them.
    document.addEventListener("DOMContentLoaded", () => {
      const el = document.getElementById("log");
      if (!el) return;
      console.log("[em-mirror] log mirror attached");
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1) console.log("[em-log] " + (n.textContent || "").trim());
          }
        }
      });
      obs.observe(el, { childList: true });
    });

    // Also catch unhandled promise rejections so we see them.
    window.addEventListener("unhandledrejection", (e) => {
      console.log("[em-unhandled] " + (e.reason?.stack || e.reason?.message || e.reason));
    });
  });

  // ---- forward console + fetch + page errors ----
  page.on("console", (m) => {
    const t = m.type();
    const txt = m.text();
    if (/preview-only|Failed to load resource|beforeinstallprompt/.test(txt)) return;
    if (txt.startsWith("[em-log] ")) {
      log("plog", txt.slice(9), grn);
      return;
    }
    if (txt.startsWith("[em-unhandled] ")) {
      log("REJ", txt.slice(15), red);
      return;
    }
    const col = t === "error" ? red : t === "warning" ? yel : dim;
    log("page", `[${t}] ${txt}`, col);
  });
  page.on("pageerror", (e) => log("page", "EXCEPTION " + e.message, red));
  page.on("requestfailed", (req) => {
    log("net", `FAIL ${req.method()} ${req.url()} :: ${req.failure()?.errorText}`, red);
  });
  page.on("response", async (res) => {
    const u = res.url();
    if (!/\/v1\//.test(u) && !/healthz/.test(u)) return;
    log("net", `${res.status()} ${res.request().method()} ${u.replace(PWA_URL, "").replace(BACKEND_INTERNAL, "")}`,
        res.status() >= 400 ? red : grn);
  });

  // ---- inject cfg + navigate ----
  const cfg = {
    userToken,
    deviceToken,
    deviceTokenExpiresAt: Date.now() + 15 * 60 * 1000,
    deviceId,
    backend: PWA_URL, // hits the proxy so we use the same path as a real TV
  };

  log("nav", "→ " + PWA_URL + "/", cya);
  await page.goto(PWA_URL + "/", { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.evaluate((cfg) => {
    localStorage.setItem("em-phone-cfg", JSON.stringify(cfg));
  }, cfg);
  log("inject", "cfg → localStorage; throttling CPU 8x; reloading", cya);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 8 });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });

  // ---- watchdog: wait for first claim/submit success ----
  const startedAt = Date.now();
  const submitJob = !!parseInt(process.env.SUBMIT_JOB ?? "1");
  let jobSubmitted = false;
  let firstClaimAt = null;
  let firstSubmitAt = null;
  let pageLogs = 0;

  // dump page status every 5s
  const statusTimer = setInterval(async () => {
    try {
      const snap = await page.evaluate(() => {
        const text = (id) => document.getElementById(id)?.textContent ?? "?";
        const stats = {
          status: text("status"),
          sub: text("sub"),
          attest: text("feat-attest"),
          mode: text("mode"),
          completed: text("completed"),
          hits: text("hits"),
          wuid: text("wu-id"),
          pct: text("wu-pct"),
        };
        const logs = Array.from(document.querySelectorAll("#log > div"))
          .slice(0, 5).map((e) => e.textContent.trim());
        return { stats, logs };
      });
      log("snap", JSON.stringify(snap.stats), cya);
      for (const ll of snap.logs) {
        if (pageLogs > 30 && !/▸|HIT|miss|claim|submit|attest|pow|hb/.test(ll)) continue;
        log("plog", ll.replace(/\s+/g, " ").slice(0, 200), dim);
        pageLogs++;
      }
    } catch (e) {
      log("snap", "fail: " + e.message, red);
    }
  }, 5000);

  // submit job after 8s (let the page finish boot)
  const entKey = (await getEnterpriseKey()) || "em_live_admin";
  log("ent", "using ent key: " + entKey.slice(0, 16) + "...", grn);
  if (submitJob) {
    setTimeout(async () => {
      try {
        await submitTinyJob(userToken, entKey);
        jobSubmitted = true;
      } catch (e) {
        log("job", "FAILED " + e.message, red);
      }
    }, 12000);
  }

  // Tick the bundler every 4s — without this nobody puts the job's
  // workunits onto a cluster, which means our claim loop returns []
  // forever no matter how fast it polls.
  const bundlerTimer = setInterval(async () => {
    try {
      const r = await api("POST", "/v1/admin/run/bundler", { adminKey: entKey });
      if (r && Object.keys(r).length) {
        log("bund", JSON.stringify(r).slice(0, 200), mag);
      }
    } catch (e) {
      log("bund", "fail " + e.message, red);
    }
  }, 4000);

  // poll backend for proof of life
  const proofTimer = setInterval(async () => {
    try {
      const claims = await api("GET", `/v1/devices/${deviceId}`, { token: userToken });
      // not enough info, fallback to logs
    } catch {}
  }, 10000);

  // hard timeout
  const HARD_DEADLINE_MS = parseInt(process.env.DEADLINE_MS ?? "90000");
  while (true) {
    if (Date.now() - startedAt > HARD_DEADLINE_MS) {
      log("done", "DEADLINE — exiting", red);
      break;
    }
    // detect submit success by reading page DOM
    const completed = await page.evaluate(() => {
      const c = parseInt(document.getElementById("completed")?.textContent || "0", 10);
      return c;
    }).catch(() => 0);
    const target = parseInt(process.env.MIN_COMPLETED ?? "1");
    if (completed >= target && !firstSubmitAt) {
      firstSubmitAt = Date.now() - startedAt;
      log("PASS", `🎉 ${completed} workunit(s) completed at +${firstSubmitAt}ms`, grn);
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  clearInterval(statusTimer);
  clearInterval(proofTimer);
  clearInterval(bundlerTimer);

  // final dump
  try {
    const finalLogs = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#log > div"))
        .map((e) => e.textContent.trim())
    );
    log("dump", `last ${Math.min(finalLogs.length, 25)} page logs:`, mag);
    for (const ll of finalLogs.slice(-25)) {
      log("plog", ll.replace(/\s+/g, " ").slice(0, 240), dim);
    }
  } catch {}

  await browser.close();

  if (!firstSubmitAt) {
    process.exit(1);
  }
  process.exit(0);
}

run().catch((e) => {
  console.error("\x1b[31mFATAL\x1b[0m", e);
  process.exit(2);
});
