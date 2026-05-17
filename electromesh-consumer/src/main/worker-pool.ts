import { Worker } from "node:worker_threads";
import path from "node:path";
import crypto from "node:crypto";

export interface WorkerJob {
  workunit_id: string;
  payload: Record<string, unknown>;
  expected_runtime_seconds: number;
}

export interface WorkerSuccess {
  type: "result";
  workunit_id: string;
  runtime_ms: number;
  result: Record<string, unknown>;
  result_hash: string;
}

export interface WorkerProgress {
  type: "progress";
  workunit_id: string;
  scanned: number;
  progress_pct: number;
}

export interface WorkerFailure {
  type: "error";
  workunit_id: string;
  runtime_ms: number;
  error_code: string;
  error_message: string;
}

export type WorkerEvent = WorkerProgress | WorkerSuccess | WorkerFailure;

const HASH_KINDS = new Set(["hashcrack.range", "hashcrack.dict"]);

export class WorkerPool {
  private maxConcurrent: number;
  private active = new Map<string, Worker>();
  private listeners = new Set<(e: WorkerEvent) => void>();

  constructor(maxConcurrent: number = Math.max(1, Math.floor(((global as unknown as { __cores?: number }).__cores ?? 4) / 2))) {
    this.maxConcurrent = maxConcurrent;
  }

  on(listener: (e: WorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get inflight(): number {
    return this.active.size;
  }

  get capacity(): number {
    return Math.max(0, this.maxConcurrent - this.active.size);
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, n);
  }

  canRun(job: WorkerJob): boolean {
    if (this.active.has(job.workunit_id)) return false;
    return HASH_KINDS.has(String(job.payload.kind ?? ""));
  }

  start(job: WorkerJob): boolean {
    if (!this.canRun(job)) return false;
    if (this.active.size >= this.maxConcurrent) return false;

    const workerPath = resolveWorkerPath();
    const worker = new Worker(workerPath, {
      workerData: {
        workunit_id: job.workunit_id,
        payload: job.payload
      }
    });

    this.active.set(job.workunit_id, worker);

    worker.on("message", (msg: WorkerEvent) => {
      if (msg.type === "result") {
        const enriched: WorkerSuccess = {
          ...msg,
          result_hash: hashJson(msg.result)
        };
        this.emit(enriched);
        this.cleanup(job.workunit_id);
      } else if (msg.type === "progress") {
        this.emit(msg);
      } else {
        this.emit(msg);
        this.cleanup(job.workunit_id);
      }
    });

    worker.on("error", (err) => {
      this.emit({
        type: "error",
        workunit_id: job.workunit_id,
        runtime_ms: 0,
        error_code: "worker_error",
        error_message: err.message
      });
      this.cleanup(job.workunit_id);
    });

    worker.on("exit", (code) => {
      if (this.active.has(job.workunit_id) && code !== 0) {
        this.emit({
          type: "error",
          workunit_id: job.workunit_id,
          runtime_ms: 0,
          error_code: "worker_exit",
          error_message: `worker exited with code ${code}`
        });
      }
      this.cleanup(job.workunit_id);
    });

    return true;
  }

  cancel(workunitId: string): void {
    const w = this.active.get(workunitId);
    if (w) {
      w.terminate().catch(() => undefined);
      this.cleanup(workunitId);
    }
  }

  cancelAll(): void {
    for (const id of [...this.active.keys()]) this.cancel(id);
  }

  private cleanup(workunitId: string): void {
    const w = this.active.get(workunitId);
    if (w) {
      w.removeAllListeners();
    }
    this.active.delete(workunitId);
  }

  private emit(e: WorkerEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        console.error("[worker-pool] listener error", err);
      }
    }
  }
}

function hashJson(obj: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(obj, Object.keys(obj as object).sort()))
    .digest("hex");
}

function resolveWorkerPath(): string {
  // The compiled hash-worker.js sits next to the compiled main bundle.
  return path.join(__dirname, "hash-worker.js");
}
