import type { ElectroMeshApi } from "./index";

declare global {
  interface Window {
    electromesh: ElectroMeshApi;
  }
}

export {};
