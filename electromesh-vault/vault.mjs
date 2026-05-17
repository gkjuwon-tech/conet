/**
 * ElectroMesh Vault — separate process that owns *real* unknown secrets.
 *
 * Why this exists:
 *   In the previous demo we cheated. The CLI knew the password ("wow") and
 *   asked the mesh to "recover" it. That's not a real test — that's selfdriving.
 *   This service fixes that. It generates secrets *we never see*, exposes
 *   only the cryptographic byproduct (hash / signature / ciphertext), and
 *   refuses to tell us the answer until we present a candidate that matches.
 *
 *   So: every demo scenario follows the same flow ↓
 *      1. Vault rolls a fresh secret with crypto.randomBytes.
 *      2. Vault returns hash/sig/ciphertext + a challenge_id.
 *      3. Mesh works on the challenge, returns a candidate.
 *      4. Vault verifies — only NOW does it confirm the original secret.
 *      5. We log "we genuinely didn't know X, mesh found X."
 *
 * Endpoints:
 *   POST /v1/challenges/password    — random short password, returns sha256
 *   POST /v1/challenges/pow         — random prefix + difficulty, find nonce
 *   POST /v1/challenges/jwt         — random HMAC secret, signs a JWT
 *   POST /v1/challenges/xor         — random XOR key, encrypts a message
 *   GET  /v1/challenges/:id         — public challenge details
 *   POST /v1/challenges/:id/verify  — submit candidate, get verdict
 *   POST /v1/challenges/:id/reveal  — admin-only: reveal stored secret post-solve
 *   GET  /v1/healthz
 */

import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";

const PORT = Number(process.env.VAULT_PORT ?? 8090);
const ADMIN_TOKEN = process.env.VAULT_ADMIN_TOKEN ?? "vault-admin-dev-only";

// --------------------------------------------------------------------------
// State — in-memory only, this is a demo service.
// --------------------------------------------------------------------------

const challenges = new Map();

const CHARSETS = {
  digits: "0123456789",
  lower: "abcdefghijklmnopqrstuvwxyz",
  alnum: "abcdefghijklmnopqrstuvwxyz0123456789",
  hex: "0123456789abcdef"
};

function newId() {
  return "ch_" + crypto.randomBytes(8).toString("hex");
}

function randomFromCharset(charset, len) {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += charset[bytes[i] % charset.length];
  }
  return out;
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// --------------------------------------------------------------------------
// Challenge factories
// --------------------------------------------------------------------------

function createPasswordChallenge({ charset = "lower", length = 3, algorithm = "sha256" } = {}) {
  const cs = CHARSETS[charset] ?? charset;
  const secret = randomFromCharset(cs, length);
  const hash = crypto.createHash(algorithm).update(secret, "utf8").digest("hex");
  const id = newId();
  challenges.set(id, {
    id,
    kind: "password",
    secret,
    public: {
      kind: "password",
      algorithm,
      target_hash: hash,
      charset: cs,
      min_length: length,
      max_length: length
    },
    created_at: Date.now(),
    solved_at: null,
    solver: null
  });
  return id;
}

function createPowChallenge({ difficulty = 16 } = {}) {
  // Prefix = a random 16-byte hex string. The solver must find a nonce N
  // such that sha256(prefix || ":" || N) starts with `difficulty` zero bits.
  const prefix = crypto.randomBytes(16).toString("hex");
  const id = newId();
  challenges.set(id, {
    id,
    kind: "pow",
    secret: null, // PoW has no secret; verification is by hash check
    public: {
      kind: "pow",
      prefix,
      algorithm: "sha256",
      difficulty_bits: Math.max(1, Math.min(32, difficulty)),
      hint:
        "Find a nonce N such that the SHA-256 of `<prefix>:N` (utf-8) has at " +
        "least difficulty_bits leading zero bits."
    },
    created_at: Date.now(),
    solved_at: null,
    solver: null
  });
  return id;
}

function createJwtChallenge({ charset = "lower", length = 4 } = {}) {
  const cs = CHARSETS[charset] ?? charset;
  const secret = randomFromCharset(cs, length);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .toString("base64url")
    .replace(/=+$/g, "");
  const payload = Buffer.from(
    JSON.stringify({ sub: "mesh-test", iat: Math.floor(Date.now() / 1000) })
  )
    .toString("base64url")
    .replace(/=+$/g, "");
  const signing = `${header}.${payload}`;
  const sig = crypto
    .createHmac("sha256", secret)
    .update(signing)
    .digest("base64url")
    .replace(/=+$/g, "");
  const token = `${signing}.${sig}`;
  const id = newId();
  challenges.set(id, {
    id,
    kind: "jwt",
    secret,
    public: {
      kind: "jwt",
      token,
      header,
      payload,
      signing_input: signing,
      target_signature: sig,
      charset: cs,
      min_length: length,
      max_length: length,
      algorithm: "HS256"
    },
    created_at: Date.now(),
    solved_at: null,
    solver: null
  });
  return id;
}

function createXorChallenge({ keyLen = 3, message = null } = {}) {
  // Plaintext is a *known* phrase (so we can verify), but the KEY is random.
  // Mesh has to recover the key; once recovered, it can decrypt.
  const plaintext = message ?? "ElectroMesh recovers your XOR key.";
  const keyBytes = crypto.randomBytes(keyLen);
  const ciphertext = Buffer.alloc(plaintext.length);
  for (let i = 0; i < plaintext.length; i++) {
    ciphertext[i] = plaintext.charCodeAt(i) ^ keyBytes[i % keyLen];
  }
  const id = newId();
  challenges.set(id, {
    id,
    kind: "xor",
    secret: keyBytes.toString("hex"),
    public: {
      kind: "xor",
      ciphertext_hex: ciphertext.toString("hex"),
      key_length: keyLen,
      // hint: the plaintext starts with "ElectroMesh" — a known crib so the
      // attack is realistic (known-plaintext attack on XOR).
      crib: "ElectroMesh"
    },
    created_at: Date.now(),
    solved_at: null,
    solver: null
  });
  return id;
}

// --------------------------------------------------------------------------
// Verification
// --------------------------------------------------------------------------

function verifyPassword(challenge, candidate) {
  if (typeof candidate !== "string") return false;
  return constantTimeEqual(challenge.secret, candidate);
}

function verifyPow(challenge, candidate) {
  if (typeof candidate !== "string") return false;
  const digest = crypto
    .createHash("sha256")
    .update(`${challenge.public.prefix}:${candidate}`, "utf8")
    .digest();
  let zeros = 0;
  for (let i = 0; i < digest.length; i++) {
    const b = digest[i];
    if (b === 0) {
      zeros += 8;
      continue;
    }
    let mask = 0x80;
    while ((b & mask) === 0 && mask !== 0) {
      zeros += 1;
      mask >>>= 1;
    }
    break;
  }
  return zeros >= challenge.public.difficulty_bits;
}

function verifyJwt(challenge, candidateSecret) {
  if (typeof candidateSecret !== "string") return false;
  const expected = challenge.public.target_signature;
  const got = crypto
    .createHmac("sha256", candidateSecret)
    .update(challenge.public.signing_input)
    .digest("base64url")
    .replace(/=+$/g, "");
  return constantTimeEqual(expected, got);
}

function verifyXor(challenge, candidateKeyHex) {
  if (typeof candidateKeyHex !== "string") return false;
  return constantTimeEqual(challenge.secret.toLowerCase(), candidateKeyHex.toLowerCase());
}

const VERIFIERS = {
  password: verifyPassword,
  pow: verifyPow,
  jwt: verifyJwt,
  xor: verifyXor
};

// --------------------------------------------------------------------------
// HTTP server
// --------------------------------------------------------------------------

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type":
      typeof body === "string" ? "text/plain; charset=utf-8" : "application/json"
  });
  res.end(text);
}

function publicView(challenge) {
  return {
    id: challenge.id,
    kind: challenge.kind,
    public: challenge.public,
    created_at: challenge.created_at,
    solved_at: challenge.solved_at,
    solver: challenge.solver,
    is_solved: challenge.solved_at !== null
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (path === "/v1/healthz" && method === "GET") {
      return send(res, 200, { status: "ok", challenges: challenges.size });
    }

    if (path === "/v1/challenges/password" && method === "POST") {
      const body = await readJsonBody(req);
      const id = createPasswordChallenge({
        charset: body.charset ?? "lower",
        length: body.length ?? 3,
        algorithm: body.algorithm ?? "sha256"
      });
      return send(res, 201, publicView(challenges.get(id)));
    }

    if (path === "/v1/challenges/pow" && method === "POST") {
      const body = await readJsonBody(req);
      const id = createPowChallenge({ difficulty: body.difficulty ?? 16 });
      return send(res, 201, publicView(challenges.get(id)));
    }

    if (path === "/v1/challenges/jwt" && method === "POST") {
      const body = await readJsonBody(req);
      const id = createJwtChallenge({
        charset: body.charset ?? "lower",
        length: body.length ?? 4
      });
      return send(res, 201, publicView(challenges.get(id)));
    }

    if (path === "/v1/challenges/xor" && method === "POST") {
      const body = await readJsonBody(req);
      const id = createXorChallenge({
        keyLen: body.key_length ?? 3,
        message: body.message ?? null
      });
      return send(res, 201, publicView(challenges.get(id)));
    }

    const ch = path.match(/^\/v1\/challenges\/(ch_[0-9a-f]+)(?:\/(verify|reveal))?$/);
    if (ch) {
      const id = ch[1];
      const action = ch[2];
      const challenge = challenges.get(id);
      if (!challenge) return send(res, 404, { error: "not found" });

      if (!action && method === "GET") {
        return send(res, 200, publicView(challenge));
      }

      if (action === "verify" && method === "POST") {
        const body = await readJsonBody(req);
        const verifier = VERIFIERS[challenge.kind];
        if (!verifier) return send(res, 500, { error: "unsupported kind" });
        const candidate = body.candidate;
        const ok = verifier(challenge, candidate);
        if (ok && !challenge.solved_at) {
          challenge.solved_at = Date.now();
          challenge.solver = body.solver ?? null;
        }
        return send(res, 200, {
          id: challenge.id,
          kind: challenge.kind,
          accepted: ok,
          solved_at: challenge.solved_at,
          solver: challenge.solver
        });
      }

      if (action === "reveal" && method === "POST") {
        const auth = req.headers["authorization"] ?? "";
        if (!auth.endsWith(ADMIN_TOKEN)) {
          return send(res, 403, { error: "vault admin token required" });
        }
        if (!challenge.solved_at) {
          return send(res, 409, { error: "challenge not solved yet — refusing to reveal" });
        }
        return send(res, 200, {
          id: challenge.id,
          kind: challenge.kind,
          secret: challenge.secret,
          revealed_at: Date.now()
        });
      }
    }

    send(res, 404, { error: "no such route" });
  } catch (err) {
    console.error("[vault] error", err);
    send(res, 500, { error: String(err?.message ?? err) });
  }
});

server.listen(PORT, () => {
  console.log(`[vault] listening on :${PORT}`);
  console.log(`[vault] admin token: ${ADMIN_TOKEN}`);
});
