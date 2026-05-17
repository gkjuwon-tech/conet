import { Tray, Menu, nativeImage, app, BrowserWindow } from "electron";
import path from "node:path";
import type { ConsumerAgent } from "./agent";

let tray: Tray | null = null;

export function setupTray(window: BrowserWindow, agent: ConsumerAgent): Tray {
  const iconPath = path.join(app.getAppPath(), "build", "trayTemplate.png");
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip("conet");
  applyMenu(window, agent);
  agent.on("status", () => applyMenu(window, agent));
  tray.on("click", () => {
    if (window.isVisible()) window.hide();
    else window.show();
  });
  return tray;
}

function applyMenu(window: BrowserWindow, agent: ConsumerAgent): void {
  if (!tray) return;
  const status = agent.status();
  const label = status.running
    ? `Mining: ${status.inflight} unit${status.inflight === 1 ? "" : "s"}`
    : "Idle";
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: `conet — ${label}`, enabled: false },
    { type: "separator" },
    {
      label: status.running ? "Pause earning" : "Resume earning",
      click: async () => {
        if (status.running) {
          await agent.stop();
        } else if (status.deviceId) {
          await agent.start(status.deviceId);
        }
      }
    },
    {
      label: "Open dashboard",
      click: () => {
        window.show();
        window.focus();
      }
    },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}
