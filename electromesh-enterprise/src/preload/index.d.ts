import type { ElectroMeshEnterpriseApi } from "./index";

declare global {
  interface Window {
    electromesh: ElectroMeshEnterpriseApi;
  }
}

export {};
