import { parentPort, workerData } from "node:worker_threads";
import crypto from "node:crypto";

interface WorkerInput {
  workunit_id: string;
  payload: {
    kind: string;
    algorithm: string;
    target_hash: string;
    salt?: string | null;
    charset: string;
    length: number;
    range_lo: number;
    range_hi: number;
  };
}

const data = workerData as WorkerInput;

function indexToCandidate(charset: string, length: number, index: number): string {
  const radix = charset.length;
  const out = new Array<string>(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = charset[index % radix]!;
    index = Math.floor(index / radix);
  }
  return out.join("");
}

function hashCandidate(algorithm: string, salt: string | null | undefined, candidate: string): string {
  const salted = (salt ?? "") + candidate;
  if (algorithm === "ntlm") {
    return crypto.createHash("md4").update(Buffer.from(candidate, "utf16le")).digest("hex");
  }
  return crypto.createHash(algorithm).update(salted, "utf8").digest("hex");
}

(function run() {
  const startedAt = Date.now();
  const { algorithm, salt, charset, length, range_lo, range_hi, target_hash } = data.payload;
  const target = target_hash.toLowerCase();

  let found: string | null = null;
  const reportEvery = 250_000;
  let scanned = 0;

  for (let i = range_lo; i < range_hi; i++) {
    const cand = indexToCandidate(charset, length, i);
    const h = hashCandidate(algorithm, salt, cand);
    if (h === target) {
      found = cand;
      break;
    }
    scanned++;
    if (scanned % reportEvery === 0) {
      parentPort?.postMessage({
        type: "progress",
        workunit_id: data.workunit_id,
        scanned,
        progress_pct: Math.min(99, ((i - range_lo) / (range_hi - range_lo)) * 100)
      });
    }
  }

  const runtimeMs = Date.now() - startedAt;
  parentPort?.postMessage({
    type: "result",
    workunit_id: data.workunit_id,
    runtime_ms: runtimeMs,
    result: {
      status: found ? "hit" : "miss",
      candidate: found,
      scanned: range_hi - range_lo,
      range_lo,
      range_hi,
      length
    }
  });
})();