/**
 * Thin wrappers around the backend's `/v1/claim/*` endpoints. The actual
 * mDNS/ARP/etc. discovery happens server-side now (post-PR #1) — the
 * Electron main process just relays.
 */

import { EventEmitter } from "node:events";
import { api } from "./api-client";

export const lanEvents = new EventEmitter();

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
        ip: d.ip,
        mac: d.mac,
        hostname: d.hostname,
        vendor: d.vendor,
        device_class: d.device_class,
        label: d.label,
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
