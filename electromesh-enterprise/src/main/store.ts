import { app, safeStorage } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { STORAGE_FILE } from "./constants";

export interface PersistedState {
  apiBase?: string;
  apiKey?: string;
  enterpriseId?: string;
  enterpriseName?: string;
  enterpriseSlug?: string;
}

class Store {
  private filePath: string;
  private cache: PersistedState = {};

  constructor() {
    this.filePath = path.join(app.getPath("userData"), STORAGE_FILE);
  }

  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath);
      const json = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(raw)
        : raw.toString("utf8");
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

  async clearAuth(): Promise<void> {
    await this.patch({
      apiKey: undefined,
      enterpriseId: undefined,
      enterpriseName: undefined,
      enterpriseSlug: undefined
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
