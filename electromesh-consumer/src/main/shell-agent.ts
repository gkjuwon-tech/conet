/**
 * Consumer-side PTY shell agent.
 *
 * When the backend dispatches a `compute.shell` workunit, the agent opens a
 * WebSocket to /v1/shell/ws/device with the per-session device token. We
 * then receive a "spawn" frame describing the shell to launch, and bridge
 * stdin/stdout/stderr between the WS and the local PTY (or fallback shell).
 *
 * In the dev path we use plain `child_process.spawn` against PowerShell or
 * /bin/sh — that's enough for SSH-style interactive use as long as the
 * enterprise's xterm sends raw keystrokes. A future build can swap in
 * `node-pty` for a real PTY (mouse, signals, raw mode) without changing the
 * wire protocol.
 *
 * Sandboxing in this dev build is *advisory*: cwd defaults to a per-session
 * scratch directory, env is whitelisted, and we kill the child if the WS
 * closes. Real productionisation needs containers — wired to a hook below.
 */

import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { app } from "electron";

import { store } from "./store";

interface SpawnFrame {
  type: "spawn";
  shell_id: string;
  image?: string | null;
  workdir?: string | null;
  cmd?: string | null;
  env: Record<string, string>;
  cpu_cap_pct: number;
  memory_mb_cap: number;
  disk_mb_cap: number;
}

const SAFE_ENV_KEYS = new Set([
  "HOME",
  "USER",
  "USERNAME",
  "TEMP",
  "TMP",
  "TZ",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM"
]);

export class ShellAgent {
  private apiBase: string;
  private deviceToken: string;
  private ws: WebSocket | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private shellId: string | null = null;
  private scratchDir: string | null = null;
  private connected = false;
  private listeners: Array<(event: { type: string; [k: string]: unknown }) => void> = [];

  constructor(opts: { apiBase: string; deviceShellToken: string }) {
    this.apiBase = opts.apiBase.replace(/\/+$/, "");
    this.deviceToken = opts.deviceShellToken;
  }

  on(listener: (event: { type: string; [k: string]: unknown }) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: { type: string; [k: string]: unknown }): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.error("[shell-agent] listener error", err);
      }
    }
  }

  async start(): Promise<void> {
    if (this.connected) return;
    const wsUrl = `${this.apiBase.replace(/^http/, "ws")}/v1/shell/ws/device?token=${encodeURIComponent(
      this.deviceToken
    )}`;
    const ws = new WebSocket(wsUrl, "electromesh.shell.v1");
    this.ws = ws;
    ws.on("open", () => {
      this.connected = true;
      this.emit({ type: "connected" });
    });
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        const text = data.toString("utf-8");
        try {
          const frame = JSON.parse(text);
          if (frame && typeof frame === "object" && frame.type === "spawn") {
            void this.spawnShell(frame as SpawnFrame);
            return;
          }
        } catch {
          /* not JSON — treat as keystrokes */
        }
        this.writeToShell(text);
      } else {
        this.writeToShell(data as Buffer);
      }
    });
    ws.on("close", () => {
      this.connected = false;
      this.killChild("ws closed");
      this.emit({ type: "closed" });
    });
    ws.on("error", (err) => {
      this.emit({ type: "error", message: String(err) });
    });
  }

  async stop(): Promise<void> {
    this.killChild("agent stop");
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  private async spawnShell(frame: SpawnFrame): Promise<void> {
    if (this.child) {
      this.killChild("respawn");
    }
    this.shellId = frame.shell_id;
    this.scratchDir = await this.makeScratchDir(frame.shell_id);
    const safeEnv = this.buildSafeEnv(frame.env);
    const cwd =
      frame.workdir && (await this.dirExists(frame.workdir))
        ? frame.workdir
        : this.scratchDir;

    const isWin = process.platform === "win32";
    let bin: string;
    let args: string[];
    if (frame.cmd) {
      // Run the requested command line through a shell.
      bin = isWin ? "powershell.exe" : "/bin/sh";
      args = isWin
        ? ["-NoLogo", "-NoProfile", "-Command", frame.cmd]
        : ["-c", frame.cmd];
    } else {
      bin = isWin ? "powershell.exe" : "/bin/bash";
      args = isWin ? ["-NoLogo", "-NoProfile"] : ["-il"];
    }

    const child = spawn(bin, args, {
      cwd,
      env: safeEnv,
      shell: false,
      windowsHide: true
    });
    this.child = child;
    this.emit({
      type: "spawned",
      shell_id: frame.shell_id,
      bin,
      cwd,
      pid: child.pid
    });
    child.stdout.on("data", (chunk: Buffer) => this.sendBytes(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.sendBytes(chunk));
    child.on("close", (code) => {
      this.sendText(`\r\n[shell exited code=${code}]\r\n`);
      this.child = null;
    });
    child.on("error", (err) => {
      this.sendText(`\r\n[shell spawn failed: ${String(err)}]\r\n`);
      this.child = null;
    });

    // Send a banner so the enterprise terminal knows it's live.
    this.sendText(
      `\r\n\x1b[1;32m✓ ElectroMesh shell ready on ${os.hostname()} (${cwd})\x1b[0m\r\n`
    );
  }

  private writeToShell(payload: string | Buffer): void {
    if (!this.child) return;
    try {
      this.child.stdin.write(payload);
    } catch (err) {
      console.warn("[shell-agent] stdin write failed", err);
    }
  }

  private sendBytes(chunk: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(chunk);
    } catch {
      /* ignore */
    }
  }

  private sendText(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(text);
    } catch {
      /* ignore */
    }
  }

  private buildSafeEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const k of SAFE_ENV_KEYS) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }
    env.PATH = process.env.PATH ?? process.env.Path ?? "";
    env.PS1 = "electromesh$ ";
    env.PROMPT = "electromesh$ ";
    for (const [k, v] of Object.entries(extra)) {
      // Only allow alphanumeric+underscore keys, refuse dangerous overrides.
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) continue;
      if (k === "LD_PRELOAD" || k === "DYLD_INSERT_LIBRARIES") continue;
      env[k] = String(v);
    }
    return env;
  }

  private async makeScratchDir(shellId: string): Promise<string> {
    const root = path.join(app.getPath("userData"), "shell-sessions", shellId);
    await fs.mkdir(root, { recursive: true });
    return root;
  }

  private async dirExists(p: string): Promise<boolean> {
    try {
      const stat = await fs.stat(p);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  private killChild(reason: string): void {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* ignore */
      }
      this.child = null;
      this.emit({ type: "child_killed", reason });
    }
  }
}

// ---------------------------------------------------------------------------
// Workunit dispatcher hook
// ---------------------------------------------------------------------------
//
// When the regular work dispatcher receives a workunit with kind ==
// "compute.shell" it spawns a ShellAgent in parallel. The HTTP submit_work
// flow returns immediately (the backend treats the workunit as long-running
// and the WS proxy handles billing).

export async function handleShellWorkunit(opts: {
  apiBase: string;
  payload: Record<string, unknown>;
}): Promise<ShellAgent | null> {
  const token = opts.payload.device_shell_token as string | undefined;
  if (!token) return null;
  const agent = new ShellAgent({
    apiBase: opts.apiBase,
    deviceShellToken: token
  });
  await agent.start();
  return agent;
}
