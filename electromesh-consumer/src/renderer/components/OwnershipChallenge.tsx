/**
 * OwnershipChallenge — verify the user actually owns a device on the LAN
 * before we claim it.
 *
 * The renderer drives a state machine:
 *
 *     idle ─→ requesting ─→ awaiting-pin ─→ verifying ─→ verified
 *       │           │            │              │
 *       │           ▼            ▼              ▼
 *       └────── error ◀──────── error ─────── error
 *
 * For PIN flow the renderer asks the backend to mint a challenge, then
 * shows the rendered PIN (dev mode) or a "look at your device" prompt
 * (prod mode where the PIN is delivered out-of-band), then collects the
 * user's typed PIN and calls /respond.
 *
 * For MAC flow there is no rendered code — the user reads the MAC off the
 * device's settings UI and types it back. The backend compares against
 * what the LAN scanner saw on the wire.
 *
 * Single-source-of-truth state lives in this component. The parent only
 * receives `onVerified(challenge_id)` when verification succeeds; it does
 * not get to peek inside the FSM.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge, type OwnershipChallengePublic, type OwnershipMethod } from "../api/bridge";

export interface OwnershipChallengeDevice {
  ip: string;
  label: string;
  mac?: string;
}

interface Props {
  device: OwnershipChallengeDevice;
  /** Which methods to offer. Defaults to ["pin_display", "mac_serial"]. */
  methods?: OwnershipMethod[];
  /** Progress label, e.g. "Device 2 of 5". Hidden when undefined. */
  progressLabel?: string;
  onVerified: (challengeId: string) => void;
  onCancel?: () => void;
}

type Phase =
  | "idle"
  | "requesting"
  | "awaiting-pin"
  | "awaiting-mac"
  | "verifying"
  | "verified";

const MAC_RE = /^([0-9A-F]{2}[:-]?){5}([0-9A-F]{2})$|^[0-9A-F]{12}$/;

const METHOD_COPY: Record<OwnershipMethod, { eyebrow: string; title: string; help: string }> = {
  pin_display: {
    eyebrow: "Method · PIN",
    title: "Read a PIN off the screen",
    help: "Works for anything with a display — TV, console, IoT panel."
  },
  mac_serial: {
    eyebrow: "Method · MAC",
    title: "Look up the MAC in settings",
    help: "Headless boxes — NAS, smart plug, fridge, anything without a screen."
  },
  signed_attestation: {
    eyebrow: "Method · Attestation",
    title: "Device-signed challenge",
    help: "For devices running the conet agent. The agent signs a nonce with its enrolled key."
  }
};

export function OwnershipChallenge({
  device,
  methods = ["pin_display", "mac_serial"],
  progressLabel,
  onVerified,
  onCancel
}: Props): JSX.Element {
  const [method, setMethod] = useState<OwnershipMethod>(methods[0] ?? "pin_display");
  const [phase, setPhase] = useState<Phase>("idle");
  const [challenge, setChallenge] = useState<OwnershipChallengePublic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pinInput, setPinInput] = useState("");
  const [macInput, setMacInput] = useState("");
  const [serialInput, setSerialInput] = useState("");

  // Reset everything when we get pointed at a new device.
  const deviceIp = device.ip;
  useEffect(() => {
    setMethod(methods[0] ?? "pin_display");
    setPhase("idle");
    setChallenge(null);
    setError(null);
    setPinInput("");
    setMacInput("");
    setSerialInput("");
  }, [deviceIp, methods]);

  // Cancel an in-flight challenge if the component unmounts mid-flow.
  const challengeIdRef = useRef<string | null>(null);
  challengeIdRef.current = challenge?.challenge_id ?? null;
  useEffect(() => {
    return () => {
      const id = challengeIdRef.current;
      if (id) {
        void bridge.ownership.cancel(id).catch(() => undefined);
      }
    };
  }, []);

  const macValid = useMemo(() => MAC_RE.test(macInput), [macInput]);
  const macUiHint = macInput.length > 0 && !macValid;

  const startChallenge = useCallback(async () => {
    setPhase("requesting");
    setError(null);
    try {
      const issued = await bridge.ownership.challenge({
        device_ip: device.ip,
        method,
        device_mac: device.mac
      });
      setChallenge(issued);
      setPhase(method === "pin_display" ? "awaiting-pin" : "awaiting-mac");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  }, [device.ip, device.mac, method]);

  const submitResponse = useCallback(async () => {
    if (!challenge) return;
    setPhase("verifying");
    setError(null);
    try {
      const result = await bridge.ownership.respond({
        challenge_id: challenge.challenge_id,
        ...(method === "pin_display" ? { pin: pinInput } : {}),
        ...(method === "mac_serial" ? { mac: macInput, serial: serialInput || undefined } : {})
      });
      if (!result.verified) {
        setError(result.message || "Verification failed.");
        // Refresh the challenge view so we show updated `attempts`. Resetting
        // to await mode is more forgiving than nuking the entire challenge.
        setChallenge({
          ...challenge,
          status: result.status,
          attempts: result.attempts
        });
        setPhase(method === "pin_display" ? "awaiting-pin" : "awaiting-mac");
        return;
      }
      setPhase("verified");
      challengeIdRef.current = null;
      onVerified(challenge.challenge_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase(method === "pin_display" ? "awaiting-pin" : "awaiting-mac");
    }
  }, [challenge, method, pinInput, macInput, serialInput, onVerified]);

  const handleCancel = useCallback(async () => {
    const id = challengeIdRef.current;
    if (id) {
      try { await bridge.ownership.cancel(id); } catch { /* swallow */ }
      challengeIdRef.current = null;
    }
    setChallenge(null);
    setPinInput("");
    setMacInput("");
    setSerialInput("");
    setError(null);
    setPhase("idle");
    onCancel?.();
  }, [onCancel]);

  const attemptsRemaining = challenge
    ? Math.max(0, challenge.max_attempts - challenge.attempts)
    : null;

  return (
    <section className="verify">
      <header className="verify__header">
        <div className="verify__title-block">
          <span className="verify__eyebrow">Verify ownership</span>
          <h2 className="verify__title">{device.label || device.ip}</h2>
          <p className="verify__lede">
            Prove you control this device before we claim it. Pick a method
            below — we never claim anything unless verification succeeds.
          </p>
        </div>
        {progressLabel && <span className="verify__progress-pill">{progressLabel}</span>}
      </header>

      {phase === "idle" && (
        <div className="verify__methods" role="radiogroup" aria-label="Verification method">
          {methods.map((m) => {
            const copy = METHOD_COPY[m];
            const isActive = method === m;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={isActive}
                className={`verify__method${isActive ? " is-active" : ""}`}
                onClick={() => setMethod(m)}
              >
                <span className="verify__method-label">{copy.eyebrow}</span>
                <span className="verify__method-title">{copy.title}</span>
                <span className="verify__method-help">{copy.help}</span>
              </button>
            );
          })}
        </div>
      )}

      {phase === "idle" && method === "pin_display" && (
        <div className="verify__panel">
          <h3 className="verify__panel-title">We'll mint a 6-digit PIN for this device</h3>
          <p className="verify__panel-lede">
            The PIN should appear on the device — its own screen, console
            output, or vendor admin page. Read it off, then type it back
            here. The PIN expires in 5 minutes and is single-use.
          </p>
          <div className="verify__actions">
            {onCancel && (
              <button type="button" className="btn btn--ghost" onClick={() => onCancel()}>
                Back
              </button>
            )}
            <button type="button" className="btn btn--primary" onClick={() => void startChallenge()}>
              Mint PIN
            </button>
          </div>
        </div>
      )}

      {phase === "idle" && method === "mac_serial" && (
        <div className="verify__panel">
          <h3 className="verify__panel-title">Look up the device's MAC address</h3>
          <p className="verify__panel-lede">
            The MAC is the device's hardware ID — not secret, but you need
            admin access to read it.
          </p>
          <ul className="verify__hint-list">
            <li>Settings → About → Network / Status</li>
            <li>System Settings → Wi-Fi → Properties</li>
            <li>Your router's "connected devices" list</li>
          </ul>
          <div className="verify__actions">
            {onCancel && (
              <button type="button" className="btn btn--ghost" onClick={() => onCancel()}>
                Back
              </button>
            )}
            <button type="button" className="btn btn--primary" onClick={() => void startChallenge()}>
              Start MAC challenge
            </button>
          </div>
        </div>
      )}

      {phase === "idle" && method === "signed_attestation" && (
        <div className="verify__panel">
          <h3 className="verify__panel-title">Device-signed attestation</h3>
          <p className="verify__panel-lede">
            This device has a conet agent installed with an enrolled key.
            The backend will issue a nonce, the agent signs it, and we
            verify the signature server-side.
          </p>
          <div className="verify__actions">
            {onCancel && (
              <button type="button" className="btn btn--ghost" onClick={() => onCancel()}>
                Back
              </button>
            )}
            <button type="button" className="btn btn--primary" onClick={() => void startChallenge()}>
              Request attestation
            </button>
          </div>
        </div>
      )}

      {phase === "requesting" && (
        <div className="verify__panel">
          <h3 className="verify__panel-title">Issuing challenge…</h3>
          <p className="verify__panel-lede">Asking the backend to mint a fresh challenge.</p>
        </div>
      )}

      {phase === "awaiting-pin" && challenge && (
        <div className="verify__panel">
          <h3 className="verify__panel-title">Enter the PIN shown on the device</h3>
          <p className="verify__panel-lede">
            Look at the device. It should display a 6-digit code right now
            {challenge.delivery_hint ? ` — ${challenge.delivery_hint}` : ""}.
            Type the code below.
          </p>

          {challenge.rendered_pin && (
            <div className="verify__pin-display">
              <span className="verify__pin-display-label">Expected on device · dev mode</span>
              <span className="verify__pin-digits">{challenge.rendered_pin}</span>
            </div>
          )}

          <div className="verify__field verify__field--pin">
            <label htmlFor="ownership-pin">PIN</label>
            <input
              id="ownership-pin"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="······"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value.replace(/\D/g, "").slice(0, 6))}
              autoFocus
            />
            {attemptsRemaining !== null && attemptsRemaining < challenge.max_attempts && (
              <span className="verify__field-hint">
                {attemptsRemaining} attempt{attemptsRemaining === 1 ? "" : "s"} remaining
              </span>
            )}
            {error && <span className="verify__field-error">{error}</span>}
          </div>

          <div className="verify__actions">
            <button type="button" className="btn btn--ghost" onClick={() => void handleCancel()}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void submitResponse()}
              disabled={pinInput.length !== 6}
            >
              Verify PIN
            </button>
          </div>
        </div>
      )}

      {phase === "awaiting-mac" && challenge && (
        <div className="verify__panel">
          <h3 className="verify__panel-title">Type the MAC you read off the device</h3>
          <p className="verify__panel-lede">
            We'll compare it with what the LAN scanner saw on the wire.
            Optionally include the serial number if the device shows one.
          </p>

          <div className="verify__field">
            <label htmlFor="ownership-mac">MAC address</label>
            <input
              id="ownership-mac"
              type="text"
              value={macInput}
              onChange={(e) => setMacInput(e.target.value.toUpperCase())}
              placeholder="AA:BB:CC:DD:EE:FF"
              autoFocus
            />
            {macUiHint && (
              <span className="verify__field-hint">Format: AA:BB:CC:DD:EE:FF (colons optional)</span>
            )}
            {error && <span className="verify__field-error">{error}</span>}
          </div>

          <div className="verify__field">
            <label htmlFor="ownership-serial">Serial (optional)</label>
            <input
              id="ownership-serial"
              type="text"
              value={serialInput}
              onChange={(e) => setSerialInput(e.target.value)}
              placeholder="Leave blank if unknown"
            />
          </div>

          {attemptsRemaining !== null && attemptsRemaining < challenge.max_attempts && (
            <span className="verify__field-hint">
              {attemptsRemaining} attempt{attemptsRemaining === 1 ? "" : "s"} remaining
            </span>
          )}

          <div className="verify__actions">
            <button type="button" className="btn btn--ghost" onClick={() => void handleCancel()}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void submitResponse()}
              disabled={!macValid}
            >
              Verify MAC
            </button>
          </div>
        </div>
      )}

      {phase === "verifying" && (
        <div className="verify__panel">
          <h3 className="verify__panel-title">Verifying…</h3>
          <p className="verify__panel-lede">Comparing your response server-side.</p>
        </div>
      )}

      {phase === "verified" && challenge && (
        <div className="verify__panel verify__panel--ok">
          <h3 className="verify__panel-title">Verified</h3>
          <p className="verify__panel-lede">
            {device.label || device.ip} is yours. Moving on.
          </p>
        </div>
      )}
    </section>
  );
}
