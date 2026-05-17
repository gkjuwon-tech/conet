/* -------------------------------------------------------------------------
 * conet brand mark — 3x3 mesh grid with one live (lime) signal node.
 * Replaces the old ElectroMesh "bolt-in-cell" mark.
 *
 * Names kept (`ElectroMark`, `ElectroWordmark`) to avoid churning every
 * import site in the consumer app. They render the *new* conet identity.
 * ------------------------------------------------------------------------- */

export function ElectroMark({ className = "w-6 h-6" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      aria-hidden
    >
      {/* hairline grid — visible in dark/light/ivory theme via currentColor */}
      <g
        stroke="currentColor"
        strokeWidth="0.75"
        strokeLinecap="square"
        opacity="0.30"
      >
        <line x1="5"  y1="5"  x2="19" y2="5"  />
        <line x1="5"  y1="12" x2="19" y2="12" />
        <line x1="5"  y1="19" x2="19" y2="19" />
        <line x1="5"  y1="5"  x2="5"  y2="19" />
        <line x1="12" y1="5"  x2="12" y2="19" />
        <line x1="19" y1="5"  x2="19" y2="19" />
      </g>
      {/* eight ink nodes */}
      <g fill="currentColor">
        <circle cx="5"  cy="5"  r="1.5" />
        <circle cx="12" cy="5"  r="1.5" />
        <circle cx="5"  cy="12" r="1.5" />
        <circle cx="12" cy="12" r="1.5" />
        <circle cx="19" cy="12" r="1.5" />
        <circle cx="5"  cy="19" r="1.5" />
        <circle cx="12" cy="19" r="1.5" />
        <circle cx="19" cy="19" r="1.5" />
      </g>
      {/* one live signal node */}
      <circle cx="19" cy="5" r="2.2" fill="#B6FF1A" />
    </svg>
  );
}

export function ElectroWordmark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`font-mono ${className}`}
      style={{
        fontWeight: 500,
        letterSpacing: "-0.02em",
        color: "var(--text)",
      }}
    >
      conet
    </span>
  );
}
