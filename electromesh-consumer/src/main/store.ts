import { app, safeStorage } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { STORAGE_FILE } from "./constants";

export interface PersistedState {
  apiBase?: string;
  userToken?: string;
  refreshToken?: string;
  userId?: string;
  userEmail?: string;
  currentDeviceId?: string;
  deviceTokens?: Record<string, string>;
  consents?: Record<string, unknown>;
  preferences?: {
    autoStart?: boolean;
    minimizeToTray?: boolean;
    allowGpu?: boolean;
    nightOnly?: boolean;
    maxCpuPct?: number;
  };
}

const PASSPHRASE = "electromesh.consumer.v1";

class Store {
  private filePath: string;
  private cache: PersistedState = {};

  constructor() {
    this.filePath = path.join(app.getPath("userData"), STORAGE_FILE);
  }

  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath);
      let json: string;
      if (safeStorage.isEncryptionAvailable()) {
        try {
          json = safeStorage.decryptString(raw);
        } catch {
          json = raw.toString("utf8");
        }
      } else {
        json = raw.toString("utf8");
      }
      this.cache = JSON.parse(json);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code !== "ENOENT") {
        console.warn("[store] read failed", e);
      }
      this.cache = {};
    }
  }

  get state(): PersistedState {
    return this.cache;
  }

  async patch(update: Partial<PersistedState>): Promise<PersistedState> {
    this.cache = { ...this.cache, ...update };
    await this.flush();
    return this.cache;
  }

  async setDeviceToken(deviceId: string, token: string): Promise<void> {
    const tokens = { ...(this.cache.deviceTokens ?? {}) };
    tokens[deviceId] = token;
    await this.patch({ deviceTokens: tokens });
  }

  async clearAuth(): Promise<void> {
    await this.patch({
      userToken: undefined,
      refreshToken: undefined,
      userId: undefined,
      userEmail: undefined
    });
  }

  private async flush(): Promise<void> {
    const json = JSON.stringify(this.cache, null, 2);
    const buffer = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json)
      : Buffer.from(json, "utf8");
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, buffer);
  }
}

export const store = new Store();

export const __passphrase = PASSPHRASE;
