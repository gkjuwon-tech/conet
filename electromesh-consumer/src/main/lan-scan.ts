/**
 * LAN discovery + claim helpers.
 *
 * Discovery runs entirely in the Electron main process (see
 * `lan-discovery.ts`). The host machine has direct access to the physical
 * LAN; the dockerised backend doesn't, so client-side scanning is the only
 * thing that actually finds the user's devices.
 *
 * The result is uploaded into the backend's scanner cache via
 * `/v1/claim/scan/ingest` so the rest of the existing claim machinery
 * (ownership challenge → execute) keeps working unchanged.
 */

import { EventEmitter } from "node:events";
import { api, HttpError } from "./api-client";
import { discover, type ScannedDevice, type ScanResult as DiscoverResult } from "./lan-discovery";

export const lanEvents = new EventEmitter();

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
    /* status endpoint isn't fatal — fall through to accept */
  }
  await api.claimAcceptTos();
  _tosAccepted = true;
}

/**
 * Push our locally-discovered device list to the backend so that the
 * scanner cache the rest of the claim machinery reads from is populated
 * with what we actually saw. Backend treats it as the canonical scan
 * result for this user's session.
 */
async function ingestIntoBackend(result: DiscoverResult): Promise<void> {
  try {
    await api.scanIngest({
      lan_fingerprint: result.lan_fingerprint,
      gateway_ip: result.gateway_ip,
      gateway_mac: result.gateway_mac,
      subnet: result.subnet,
      devices: result.items.map((d) => ({
        ip: d.ip,
        mac: d.mac,
        hostname: d.hostname,
        vendor: d.vendor,
        device_class: d.device_class,
        is_gateway: d.device_class === "router",
        randomized_mac: d.randomized_mac,
        is_self: d.is_self,
      })),
    });
  } catch (err) {
    // Ingest is best-effort. A backend without the ingest endpoint (older
    // build, or in the middle of a deploy) shouldn't break the wizard —
    // we just won't be able to /execute pair on those rows.
    if (err instanceof HttpError && err.status !== 404) throw err;
  }
}

export async function autoClaimLocalLan(): Promise<{ lan_fingerprint: string }> {
  await acceptClaimTos();
  const result = await discover((p) => lanEvents.emit("scan:progress", p));
  await ingestIntoBackend(result);

  // Short-circuit if we already hold a verified claim for this LAN.
  try {
    const existing = await api.lanClaimList();
    if (Array.isArray(existing)) {
      const verified = existing.find(
        (c) => c.lan_fingerprint === result.lan_fingerprint && c.status === "verified"
      );
      if (verified) return { lan_fingerprint: result.lan_fingerprint };
    }
  } catch {
    /* listing isn't fatal */
  }

  const claimRes = await api.lanClaimRequest({
    lan_fingerprint: result.lan_fingerprint,
    label: "This device",
  });
  const otp =
    typeof claimRes.delivered_otp_dev === "string"
      ? claimRes.delivered_otp_dev
      : null;
  if (!otp) {
    throw new Error(
      "LAN claim requires an OTP that isn't being delivered in-app. " +
      "Set EM_LAN_CLAIM_DEV_SHOW_OTP=1 or use the LAN wizard."
    );
  }
  await api.lanClaimVerify({ lan_fingerprint: result.lan_fingerprint, otp });
  return { lan_fingerprint: result.lan_fingerprint };
}

export interface ScanSummary {
  lan_fingerprint?: string;
  count: number;
  items: ScannedDevice[];
}

export async function scan(): Promise<ScanSummary> {
  const result = await discover((p) => lanEvents.emit("scan:progress", p));
  await ingestIntoBackend(result);
  return {
    count: result.count,
    items: result.items,
    lan_fingerprint: result.lan_fingerprint,
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
        lan_fingerprint: d.lan_fingerprint || input.lanFingerprint,
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
      last: d,
    });
  }
  lanEvents.emit("pair:progress", { phase: "done", pct: 100, total: items.length, paired: i });
  return { total: items.length, paired: i, results: paired };
}
