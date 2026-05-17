/**
 * Thin wrappers around the backend's `/v1/claim/*` endpoints. The actual
 * mDNS/ARP/etc. discovery happens server-side now (post-PR #1) — the
 * Electron main process just relays.
 */

import { EventEmitter } from "node:events";
import { api, HttpError } from "./api-client";

export const lanEvents = new EventEmitter();

/**
 * Accept the LAN-claim ToS for the current user. The accept endpoint is
 * idempotent server-side so calling it twice is safe; we just don't want to
 * hammer it on every scan when we know the user already accepted.
 */
let _tosAccepted = false;
export async function acceptClaimTos(): Promise<void> {
  if (_tosAccepted) return;
  try {
    const status = await api.claimTosStatus();
    if (status?.accepted) {
      _tosAccepted = true;
      return;
    }
  } catch {
    // status endpoint isn't fatal — fall through to accept.
  }
  await api.claimAcceptTos();
  _tosAccepted = true;
}

/**
 * Run the full "claim this LAN for the local user" chain:
 *   1. accept claim-ToS (idempotent)
 *   2. trigger a scan so the backend computes the lan_fingerprint
 *   3. read scan results to fetch the fingerprint
 *   4. if no existing verified claim — request a claim, then verify with
 *      the dev OTP (in dev builds the OTP comes back in the response body).
 *
 * Returns the verified `lan_fingerprint`. The PairDevice flow needs this
 * before calling `/v1/devices/register`, which is hard-gated on the
 * caller holding a verified LanClaim for the LAN.
 */
export async function autoClaimLocalLan(): Promise<{ lan_fingerprint: string }> {
  await acceptClaimTos();

  // Kick off discovery + read the cached results to grab the fingerprint.
  // The backend computes one even when the only device on the LAN is us.
  await api.scanLan();
  const results = await api.scanLanResults();
  const fp =
    typeof (results as { lan_fingerprint?: string })?.lan_fingerprint === "string"
      ? (results as { lan_fingerprint: string }).lan_fingerprint
      : null;
  if (!fp) {
    throw new Error("Could not compute a LAN fingerprint. Make sure you're online.");
  }

  // Short-circuit if we already hold a verified claim for this LAN.
  try {
    const existing = await api.lanClaimList();
    if (Array.isArray(existing)) {
      const verified = existing.find(
        (c) => c.lan_fingerprint === fp && c.status === "verified"
      );
      if (verified) return { lan_fingerprint: fp };
    }
  } catch {
    // listing isn't fatal — fall through to request a fresh claim.
  }

  const claimRes = await api.lanClaimRequest({
    lan_fingerprint: fp,
    label: "This device",
  });
  const otp =
    typeof claimRes.delivered_otp_dev === "string"
      ? claimRes.delivered_otp_dev
      : null;
  if (!otp) {
    // Dev OTP isn't on — in this case the user needs to verify out of band.
    // Surface a clear hint instead of leaking the endpoint.
    throw new Error(
      "LAN claim requires an OTP that isn't being delivered in-app. " +
      "Set EM_LAN_CLAIM_DEV_SHOW_OTP=1 or use the LAN wizard."
    );
  }
  try {
    await api.lanClaimVerify({ lan_fingerprint: fp, otp });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw err;
  }

  return { lan_fingerprint: fp };
}

export interface ScanSummary {
  lan_fingerprint?: string;
  count: number;
  items: unknown[];
}

export async function scan(): Promise<ScanSummary> {
  lanEvents.emit("scan:progress", { phase: "starting", pct: 5 });
  await api.scanLan();
  lanEvents.emit("scan:progress", { phase: "polling", pct: 35 });
  const raw = await api.scanLanResults();
  const items = Array.isArray((raw as { items?: unknown[] })?.items)
    ? (raw as { items: unknown[] }).items
    : Array.isArray(raw)
      ? raw as unknown[]
      : [];
  lanEvents.emit("scan:progress", { phase: "done", pct: 100, count: items.length });
  return {
    count: items.length,
    items,
    lan_fingerprint:
      typeof (raw as { lan_fingerprint?: string })?.lan_fingerprint === "string"
        ? (raw as { lan_fingerprint: string }).lan_fingerprint
        : undefined
  };
}

export async function claimRequest(payload: {
  lan_fingerprint: string;
  label?: string;
  gateway_mac?: string;
  advertised_subnet?: string;
}) {
  return api.lanClaimRequest(payload);
}

export async function claimVerify(payload: { lan_fingerprint: string; otp: string }) {
  return api.lanClaimVerify(payload);
}

export async function claimList() {
  return api.lanClaimList();
}

export interface PairAllInput {
  devices: Array<{
    ip: string;
    mac: string;
    hostname: string | null;
    vendor: string;
    device_class: string;
    label: string;
    randomized_mac: boolean;
    lan_fingerprint: string;
  }>;
  lanFingerprint: string;
  skipRandomized?: boolean;
  skipRouter?: boolean;
}

export async function pairAll(input: PairAllInput) {
  const items = input.devices.filter((d) => {
    if (input.skipRandomized && d.randomized_mac) return false;
    if (input.skipRouter && (d.device_class === "router" || d.device_class === "gateway")) return false;
    return true;
  });
  lanEvents.emit("pair:progress", { phase: "starting", pct: 5, total: items.length, paired: 0 });
  const paired: unknown[] = [];
  let i = 0;
  for (const d of items) {
    try {
      const res = await api.claimExecute({
        target_ip: d.ip,
        lan_fingerprint: d.lan_fingerprint
      });
      paired.push(res);
    } catch (err) {
      paired.push({ ip: d.ip, error: err instanceof Error ? err.message : String(err) });
    }
    i += 1;
    lanEvents.emit("pair:progress", {
      phase: "pairing",
      pct: Math.round((i / items.length) * 95),
      total: items.length,
      paired: i,
      last: d
    });
  }
  lanEvents.emit("pair:progress", { phase: "done", pct: 100, total: items.length, paired: i });
  return { total: items.length, paired: i, results: paired };
}
