import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "./constants";
import { store } from "./store";
import { ApiClient, HttpError } from "./api-client";
import { runOAuthFlow } from "./oauth";
import { readSystemSnapshot } from "./system-info";
import { runFullBenchmark } from "./benchmark";
import type { ConsumerAgent } from "./agent";
import { buildPairingUrl, getPhoneAgentStatus } from "./phone-agent-server";

export function registerIpc(window: BrowserWindow, api: ApiClient, agent: ConsumerAgent): void {
  ipcMain.handle(IPC.config, () => ({
    apiBase: store.state.apiBase ?? api.baseUrl,
    preferences: store.state.preferences ?? {
      autoStart: true,
      minimizeToTray: true,
      allowGpu: false,
      nightOnly: false,
      maxCpuPct: 10
    }
  }));

  ipcMain.handle(IPC.configSet, async (_e, payload: { apiBase?: string; preferences?: Record<string, unknown> }) => {
    if (payload.apiBase) {
      api.setBaseUrl(payload.apiBase);
      await store.patch({ apiBase: payload.apiBase });
    }
    if (payload.preferences) {
      await store.patch({ preferences: { ...(store.state.preferences ?? {}), ...payload.preferences } });
    }
    return { ok: true };
  });

  ipcMain.handle(IPC.authState, async () => {
    if (!store.state.userToken) return { authenticated: false };
    try {
      const me = await api.me();
      return { authenticated: true, user: me, currentDeviceId: store.state.currentDeviceId ?? null };
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        await store.clearAuth();
      }
      return { authenticated: false, error: formatError(err) };
    }
  });

  ipcMain.handle(IPC.authLogin, async (_e, payload: { email: string; password: string }) => {
    try {
      const res = await api.login(payload.email, payload.password);
      await store.patch({
        userToken: res.access_token,
        refreshToken: res.refresh_token,
        userEmail: payload.email
      });
      const me = await api.me();
      await store.patch({ userId: me.id });
      return { ok: true, user: me };
    } catch (err) {
      return { ok: false, error: formatError(err) };
    }
  });

  ipcMain.handle(
    IPC.authRegister,
    async (
      _e,
      payload: {
        email: string;
        password: string;
        display_name?: string;
        country_code?: string;
        accepted_tos_version: string;
      }
    ) => {
      try {
        await api.register({
          ...payload,
          accepted_tos_version: payload.accepted_tos_version ?? "v1"
        });
        const login = await api.login(payload.email, payload.password);
        await store.patch({
          userToken: login.access_token,
          refreshToken: login.refresh_token,
          userEmail: payload.email
        });
        const me = await api.me();
        await store.patch({ userId: me.id });
        return { ok: true, user: me };
      } catch (err) {
        return { ok: false, error: formatError(err) };
      }
    }
  );

  ipcMain.handle(IPC.authLogout, async () => {
    await agent.stop();
    await store.clearAuth();
    return { ok: true };
  });

  ipcMain.handle(IPC.authOauth, async (_e, provider: "google" | "apple") => {
    try {
      return await runOAuthFlow(api, provider);
    } catch (err) {
      return { ok: false, error: formatError(err) };
    }
  });

  ipcMain.handle(IPC.deviceList, async () => {
    try {
      return { ok: true, items: await api.listDevices() };
    } catch (err) {
      return { ok: false, error: formatError(err) };
    }
  });

  ipcMain.handle(IPC.deviceCurrent, () => ({
    deviceId: store.state.currentDeviceId ?? null
  }));

  ipcMain.handle(IPC.deviceSetCurrent, async (_e, deviceId: string | null) => {
    await store.patch({ currentDeviceId: deviceId ?? undefined });
    return { ok: true };
  });

  ipcMain.handle(IPC.systemInfo, async () => {
    return readSystemSnapshot();
  });

  ipcMain.handle(
    IPC.deviceRegister,
    async (
      _e,
      payload: {
        label?: string;
        device_class: string;
        consents?: Record<string, unknown>;
        capabilities?: Record<string, unknown>;
      }
    ) => {
      try {
        const sys = await readSystemSnapshot();
        const device = await api.registerDevice({
          label: payload.label ?? sys.hostname,
          device_class: payload.device_class ?? sys.inferredDeviceClass,
          vendor: sys.cpuModel.split(" ")[0],
          model: sys.cpuModel,
          os: sys.os,
          arch: sys.arch,
          firmware: undefined,
          consents: payload.consents,
          capabilities: payload.capabilities,
          lan_fingerprint: sys.lanFingerprint
        });
        const issued = await api.issueDeviceToken(device.id);
        await store.setDeviceToken(device.id, issued.token);
        await store.patch({ currentDeviceId: device.id });
        return { ok: true, device };
      } catch (err) {
        return { ok: false, error: formatError(err) };
      }
    }
  );

  ipcMain.handle(IPC.deviceDecommission, async (_e, deviceId: string) => {
    try {
      const stopped = store.state.currentDeviceId === deviceId;
      if (stopped) await agent.stop();
      const dev = await api.decommissionDevice(deviceId);
      const tokens = { ...(store.state.deviceTokens ?? {}) };
      delete tokens[deviceId];
      await store.patch({
        deviceTokens: tokens,
        currentDeviceId: stopped ? undefined : store.state.currentDeviceId
      });
      return { ok: true, device: dev };
    } catch (err) {
      return { ok: false, error: formatError(err) };
    }
  });

  ipcMain.handle(IPC.deviceBenchmark, async (_e, deviceId: string) => {
    try {
      const submission = await runFullBenchmark((p) => {
        window.webContents.send("benchmark:progress", p);
      });
      const updated = await api.submitBenchmark(deviceId, submission);
      return { ok: true, device: updated, submission };
    } catch (err) {
      return { ok: false, error: formatError(err) };
    }
  });

  ipcMain.handle(IPC.agentStatus, () => agent.status());

  ipcMain.handle(IPC.agentStart, async (_e, deviceId?: string) => {
    try {
      const id = deviceId ?? store.state.currentDeviceId;
      if (!id) throw new Error("no device selected");
      await agent.start(id);
      return { ok: true, status: agent.status() };
    } catch (err) {
      return { ok: false, error: formatError(err) };
    }
  });

  ipcMain.handle(IPC.agentStop, async () => {
    await agent.stop();
    return { ok: true, status: agent.status() };
  });

  ipcMain.handle(IPC.earningsHistory, async () => {
    try {
      const dash = await api.dashboard();
      return { ok: true, dashboard: dash };
    } catch (err) {
      return { ok: false, error: formatError(err) };
    }
  });

  ipcMain.handle(IPC.payoutRequest, async () => {
    try {
      return { ok: true, payout: await api.requestPayout() };
    } catch (err) {
      return { ok: false, error: formatError(err) };
    }
  });

  ipcMain.handle(IPC.apiCall, async (_e, opts: { method?: string; path: string; body?: unknown }) => {
    try {
      return {
        ok: true,
        data: await api.call({
          method: (opts.method as "GET" | "POST" | "PATCH" | "DELETE" | "PUT") ?? "GET",
          path: opts.path,
          body: opts.body
        })
      };
    } catch (err) {
      return { ok: false, error: formatError(err) };
    }
  });

  agent.on("status", (status) => {
    window.webContents.send(IPC.agentEvent, { type: "status", status });
  });

  // ---- LAN scan + claim + pair-all ----
  ipcMain.handle(IPC.lanScan, async () => {
    const { discoverLanDevices } = await import("./lan-scan");
    try {
      const result = await discoverLanDevices((event) => {
        window.webContents.send(IPC.lanScanProgress, event);
      });
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: formatError(err) };
    }
  });

  ipcMain.handle(
    IPC.lanClaimRequest,
    async (
      _e,
      payload: {
        lan_fingerprint: string;
        label?: string;
        gateway_mac?: string;
        advertised_subnet?: string;
      }
    ) => {
      try {
        return { ok: true, claim: await api.lanClaimRequest(payload) };
      } catch (err) {
        return { ok: false, error: formatError(err) };
      }
    }
  );

  ipcMain.handle(
    IPC.lanClaimVerify,
    async (_e, payload: { lan_fingerprint: string; otp: string }) => {
      try {
        return { ok: true, claim: await api.lanClaimVerify(payload) };
      } catch (err) {
        return { ok: false, error: formatError(err) };
      }
    }
  );

  ipcMain.handle(IPC.lanClaimList, async () => {
    try {
      return { ok: true, claims: await api.lanClaimList() };
    } catch (err) {
      return { ok: false, error: formatError(err) };
    }
  });

  ipcMain.handle(
    IPC.lanPairAll,
    async (
      _e,
      opts: {
        devices?: Array<{
          ip: string;
          mac: string;
          hostname: string | null;
          vendor: string;
          device_class: string;
          label: string;
          randomized_mac: boolean;
          lan_fingerprint: string;
        }>;
        lanFingerprint?: string;
        skipRandomized?: boolean;
        skipRouter?: boolean;
      }
    ) => {
      try {
        const { syntheticBenchmark } = await import("./lan-scan");

        if (!opts.devices || !opts.lanFingerprint) {
          return {
            ok: false,
            error: "missing scan data — re-run the LAN scan first"
          };
        }

        const claims = await api.lanClaimList();
        const verified = claims.find(
          (c) =>
            c.lan_fingerprint === opts.lanFingerprint &&
            c.status === "verified" &&
            c.is_active
        );
        if (!verified) {
          return {
            ok: false,
            error: "LAN not claimed yet — open the LAN claim wizard first"
          };
        }

        const filtered = opts.devices.filter((d) => {
          if (opts.skipRandomized && d.randomized_mac) return false;
          if (opts.skipRouter && d.device_class === "router") return false;
          return true;
        });

        const registeredDevices: Array<{ d: any; dev: any }> = [];
        const registered: { id: string; label: string; status: string; class: string }[] = [];
        const failures: { label: string; error: string }[] = [];

        // 1단계: 모든 기기 등록
        for (const d of filtered) {
          window.webContents.send(IPC.lanPairProgress, {
            stage: "registering",
            device: d
          });
          try {
            const dev = await api.registerDevice({
              label: d.label,
              device_class: d.device_class,
              vendor: d.vendor,
              model: `${d.vendor} (${d.mac})`,
              os: d.hostname ?? "unknown",
              arch: "unknown",
              consents: {
                compute_share: true,
                network_share: true,
                storage_share: false,
                night_only: false,
                max_cpu_pct: 10,
                max_gpu_pct: 0,
                max_bandwidth_mbps: 2,
                blackout_hours: []
              },
              capabilities: {
                sha256: [
                  "laptop",
                  "desktop",
                  "console",
                  "gpu_rig",
                  "phone",
                  "tablet",
                  "nas"
                ].includes(d.device_class),
                argon2: false,
                ml_inference: false,
                fhe: false,
                mpc: false,
                render: false,
                secure_enclave: ["phone", "tablet"].includes(d.device_class),
                tpm: false
              },
              lan_fingerprint: d.lan_fingerprint
            });

            try {
              await api.issueDeviceToken(dev.id);
            } catch (tokErr) {
              console.warn(
                "[pair-all] issue-token failed for",
                d.label,
                formatError(tokErr)
              );
            }

            registeredDevices.push({ d, dev });
            registered.push({
              id: dev.id,
              label: d.label,
              status: dev.status,
              class: d.device_class
            });
            window.webContents.send(IPC.lanPairProgress, {
              stage: "registered",
              id: dev.id,
              label: d.label,
              h100eq: 0 // Will be updated after benchmark
            });
          } catch (err) {
            const msg = formatError(err);
            console.error("[pair-all] register failed for", d.label, msg);
            failures.push({ label: d.label, error: msg });
            window.webContents.send(IPC.lanPairProgress, {
              stage: "failed",
              label: d.label,
              error: msg
            });
          }
        }

        // 2단계: 벤치마크 단계 시작 알림
        window.webContents.send(IPC.lanPairProgress, {
          stage: "benchmark-start"
        });

        // 3단계: 등록된 모든 기기 벤치마크
        for (const { d, dev } of registeredDevices) {
          let benchedH100 = 0;
          window.webContents.send(IPC.lanPairProgress, {
            stage: "benchmarking",
            label: d.label,
            device: d
          });
          try {
            const bench = syntheticBenchmark(d.device_class);
            const benched = await api.submitBenchmark(dev.id, bench);
            benchedH100 = benched.h100_equivalent;

            window.webContents.send(IPC.lanPairProgress, {
              stage: "bench-finished",
              label: d.label,
              h100eq: benchedH100,
              device: d
            });
          } catch (benchErr) {
            console.warn(
              "[pair-all] benchmark failed for",
              d.label,
              formatError(benchErr)
            );

            window.webContents.send(IPC.lanPairProgress, {
              stage: "bench-failed",
              label: d.label,
              error: formatError(benchErr),
              device: d
            });
          }
        }

        return { ok: true, registered, failures };
      } catch (err) {
        const msg = formatError(err);
        console.error("[pair-all] outer handler error:", msg);
        return { ok: false, error: msg };
      }
    }
  );

  // -------------------------------------------------------------------------
  // Phone-agent (LAN-hosted PWA for phones / tablets)
  // -------------------------------------------------------------------------
  ipcMain.handle(IPC.phoneAgentStatus, () => getPhoneAgentStatus());

  ipcMain.handle(IPC.phoneAgentActivations, async () => {
    try {
      const phoneStatus = getPhoneAgentStatus();
      if (!phoneStatus.ready || !store.state.userToken) {
        return { ok: false, error: "phone-agent not ready or not signed in" };
      }
      const devices = await api.listDevices();
      const phones = devices.filter(
        (d) =>
          ["phone", "tablet"].includes(d.device_class) &&
          d.status !== "decommissioned"
      );
      const backendUrl =
        (store.state.apiBase ?? api.baseUrl).replace("localhost", phoneStatus.gatewayIp).replace("127.0.0.1", phoneStatus.gatewayIp);
      const activations = phones.map((d) => ({
        device_id: d.id,
        label: d.label,
        device_class: d.device_class,
        status: d.status,
        h100_equivalent: d.h100_equivalent,
        url: buildPairingUrl({
          userToken: store.state.userToken!,
          deviceId: d.id,
          backendUrl
        })
      }));
      return { ok: true, server: phoneStatus, activations };
    } catch (err) {
      return { ok: false, error: formatError(err) };
    }
  });
}

function formatError(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.detail) {
      // detail은 보통 pydantic validation error 구조라 유용함
      return `${err.code}: ${err.message} (${JSON.stringify(err.detail)})`;
    }
    return `${err.code}: ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
