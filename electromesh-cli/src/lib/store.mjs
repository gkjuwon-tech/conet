import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const DIR = process.env.EM_HOME || path.join(HOME, ".electromesh");
const FILE = path.join(DIR, "state.json");

const DEFAULTS = {
  apiBase: process.env.EM_API_BASE || "http://localhost:8080",
  user: null,
  userToken: null,
  refreshToken: null,
  currentDeviceId: null,
  deviceTokens: {},
  enterprise: { apiKey: null, id: null, slug: null }
};

let cache = null;

async function ensureLoaded() {
  if (cache) return cache;
  await fs.mkdir(DIR, { recursive: true });
  try {
    const raw = await fs.readFile(FILE, "utf8");
    cache = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    cache = { ...DEFAULTS };
  }
  return cache;
}

async function flush() {
  await fs.writeFile(FILE, JSON.stringify(cache, null, 2));
}

export const store = {
  async get(key) {
    const c = await ensureLoaded();
    return key === undefined ? c : c[key];
  },
  async set(patch) {
    const c = await ensureLoaded();
    cache = { ...c, ...patch };
    await flush();
    return cache;
  },
  async patchEnterprise(patch) {
    const c = await ensureLoaded();
    cache = { ...c, enterprise: { ...c.enterprise, ...patch } };
    await flush();
    return cache;
  },
  async setDeviceToken(id, token) {
    const c = await ensureLoaded();
    cache = {
      ...c,
      deviceTokens: { ...c.deviceTokens, [id]: token }
    };
    await flush();
    return cache;
  },
  async clearAuth() {
    const c = await ensureLoaded();
    cache = {
      ...c,
      user: null,
      userToken: null,
      refreshToken: null
    };
    await flush();
  },
  filePath: FILE
};
