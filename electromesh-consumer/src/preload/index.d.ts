import type { ElectromeshBridge } from "./index";

declare global {
  interface Window {
    electromesh: ElectromeshBridge;
  }
}
