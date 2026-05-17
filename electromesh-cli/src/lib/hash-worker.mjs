import { parentPort, workerData } from "node:worker_threads";
import crypto from "node:crypto";

const { workunit_id, payload } = workerData;

function indexToCandidate(charset, length, index) {
  const radix = charset.length;
  const out = new Array(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = charset[index % radix];
    index = Math.floor(index / radix);
  }
  return out.join("");
}

function hashCandidate(algorithm, salt, candidate) {
  const salted = (salt ?? "") + candidate;
  if (algorithm === "ntlm") {
    return crypto
      .createHash("md4")
      .update(Buffer.from(candidate, "utf16le"))
      .digest("hex");
  }
  return crypto.createHash(algorithm).update(salted, "utf8").digest("hex");
}

(function run() {
  const startedAt = Date.now();
  const { algorithm, salt, charset, length, range_lo, range_hi, target_hash } = payload;
  const target = String(target_hash).toLowerCase();

  let found = null;
  const reportEvery = 200_000;
  let scanned = 0;

  for (let i = range_lo; i < range_hi; i++) {
    const cand = indexToCandidate(charset, length, i);
    if (hashCandidate(algorithm, salt, cand) === target) {
      found = cand;
      break;
    }
    scanned++;
    if (scanned % reportEvery === 0) {
      parentPort?.postMessage({
        type: "progress",
        workunit_id,
        scanned,
        progress_pct: Math.min(99, ((i - range_lo) / (range_hi - range_lo)) * 100)
      });
    }
  }

  parentPort?.postMessage({
    type: "result",
    workunit_id,
    runtime_ms: Date.now() - startedAt,
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
