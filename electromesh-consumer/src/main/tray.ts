import { app, Tray, Menu, nativeImage, BrowserWindow } from "electron";
import path from "node:path";
import { agent } from "./agent";
import { persistence } from "./store";

let tray: Tray | null = null;

export function initTray(win: BrowserWindow) {
  const iconPath = path.join(process.cwd(), "build", "icon.png");
  let img: Electron.NativeImage;
  try {
    img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) img = nativeImage.createEmpty();
  } catch {
    img = nativeImage.createEmpty();
  }
  tray = new Tray(img);
  tray.setToolTip("ElectroMesh");
  refreshMenu(win);
  tray.on("click", () => {
    if (!win.isVisible()) win.show();
    win.focus();
  });
  agent.on("event", () => refreshMenu(win));
}

function refreshMenu(win: BrowserWindow) {
  if (!tray) return;
  const status = agent.getStatus();
  const menu = Menu.buildFromTemplate([
    {
      label: status.running ? `Agent · running` : `Agent · stopped`,
      enabled: false
    },
    {
      label: status.running ? "Stop agent" : "Start agent",
      click: async () => {
        try {
          if (status.running) await agent.stop();
          else await agent.start();
        } catch {
          /* swallow — surfaced in UI */
        }
      },
      enabled: Boolean(persistence.currentDeviceId)
    },
    { type: "separator" },
    {
      label: "Open dashboard",
      click: () => {
        if (!win.isVisible()) win.show();
        win.focus();
      }
    },
    {
      label: "Settings",
      click: () => {
        if (!win.isVisible()) win.show();
        win.focus();
        win.webContents.send("nav:goto", "/settings");
      }
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
}

export function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
