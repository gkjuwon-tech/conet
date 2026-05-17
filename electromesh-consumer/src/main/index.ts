import { app, BrowserWindow, shell, Menu } from "electron";
import path from "node:path";
import os from "node:os";
import { store } from "./store";
import { ApiClient } from "./api-client";
import { ConsumerAgent } from "./agent";
import { WorkerPool } from "./worker-pool";
import { registerIpc } from "./ipc";
import { setupTray } from "./tray";
import { startPhoneAgentServer } from "./phone-agent-server";

(global as unknown as { __cores?: number }).__cores = os.cpus().length;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let agent: ConsumerAgent | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#0b0d12",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    show: false,
    icon: path.join(__dirname, "../../build/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });

  Menu.setApplicationMenu(null);

  mainWindow.on("ready-to-show", () => mainWindow?.show());

  // Always log renderer-side errors to the main-process stdout for easy
  // debugging when the window is blank.
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error("[renderer] did-fail-load", { code, desc, url });
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error("[renderer] render-process-gone", details);
  });
  mainWindow.webContents.on(
    "console-message",
    (_e, level, message, line, sourceId) => {
      const tag = ["debug", "info", "warn", "error"][level] ?? "log";
      console.log(`[renderer:${tag}] ${message} (${sourceId}:${line})`);
    }
  );

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.EM_DEVTOOLS === "1" || !app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    void mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("close", (event) => {
    if (store.state.preferences?.minimizeToTray !== false) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

app.whenReady().then(async () => {
  // dev에서 “캐시 잔상” 때문에 상태가 꼬이는 문제를 방지하기 위해,
  // 개발 환경이면 store 파일을 강제로 초기화한다.
  if (!app.isPackaged) {
    try {
      // eslint-disable-next-line no-console
      console.log("[dev] clearing electomesh-consumer store cache");
      await store.patch({
        apiBase: undefined,
        userToken: undefined,
        refreshToken: undefined,
        userId: undefined,
        userEmail: undefined,
        currentDeviceId: undefined
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[dev] store cache clear failed", e);
    }
  }

  await store.init();
  const api = new ApiClient();
  const pool = new WorkerPool(Math.max(1, Math.floor(os.cpus().length / 2)));
  agent = new ConsumerAgent(api, pool);

  createWindow();
  if (mainWindow) {
    registerIpc(mainWindow, api, agent);
    setupTray(mainWindow, agent);
  }

  // Boot the embedded phone-agent HTTP server. Phones / tablets on the same
  // Wi-Fi will load the PWA from this URL and start pulling real workunits.
  void startPhoneAgentServer().catch((e) =>
    console.error("[phone-agent] start failed", e)
  );

  if (
    store.state.userToken &&
    store.state.currentDeviceId &&
    store.state.preferences?.autoStart !== false
  ) {
    void agent
      .start(store.state.currentDeviceId)
      .catch((err) => console.error("[autostart]", err));
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  if (agent) await agent.stop();
});
