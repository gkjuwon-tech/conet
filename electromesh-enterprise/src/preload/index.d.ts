import type { ElectromeshEnterpriseBridge } from "./index";

declare global {
  interface Window {
    electromesh: ElectromeshEnterpriseBridge;
  }
}
