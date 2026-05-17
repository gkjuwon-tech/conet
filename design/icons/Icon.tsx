import * as React from "react";

/* ────────────────────────────────────────────────────────────────────────
   conet · Icon
   30 monoline icons, 24×24 viewBox, 1.4px stroke, currentColor.

   Why inline path data here instead of using <use href="sprite.svg#id">?
   - Zero external requests / CORS-free in Electron file://.
   - Tree-shakeable per-icon if we ever split this file.
   - Identical output as the static <svg><use> path used by landing /
     phone-agent (sprite.svg next to this file).
   ──────────────────────────────────────────────────────────────────────── */

export type IconName =
  // devices (16)
  | "phone" | "tablet" | "tv" | "console" | "desktop" | "nas"
  | "router" | "fridge" | "washer" | "bulb" | "plug" | "microwave"
  | "bot" | "camera" | "soundbar" | "stb"
  // ui (14)
  | "arrow-right" | "arrow-left" | "arrow-up-right"
  | "check" | "x" | "plus" | "search" | "settings"
  | "chevron-down" | "chevron-right"
  | "copy" | "download" | "external" | "info" | "warn" | "zap";

type Body = React.ReactNode;

const PATHS: Record<IconName, Body> = {
  phone: (<><rect x="7" y="2" width="10" height="20" rx="1.5"/><line x1="10" y1="18.5" x2="14" y2="18.5"/></>),
  tablet: (<><rect x="4" y="3" width="16" height="18" rx="1.5"/><line x1="11" y1="18.5" x2="13" y2="18.5"/></>),
  tv: (<><rect x="2" y="4" width="20" height="13" rx="1"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></>),
  console: (<><rect x="2" y="8" width="20" height="10" rx="3"/><circle cx="8" cy="13" r="1.4"/><circle cx="15" cy="11" r="0.9" fill="currentColor"/><circle cx="17" cy="14" r="0.9" fill="currentColor"/></>),
  desktop: (<><rect x="2" y="4" width="20" height="14" rx="1"/><line x1="8" y1="22" x2="16" y2="22"/><line x1="12" y1="18" x2="12" y2="22"/></>),
  nas: (<><rect x="3" y="4" width="18" height="4"/><rect x="3" y="10" width="18" height="4"/><rect x="3" y="16" width="18" height="4"/><circle cx="6" cy="6" r="0.7" fill="currentColor"/><circle cx="6" cy="12" r="0.7" fill="currentColor"/><circle cx="6" cy="18" r="0.7" fill="currentColor"/></>),
  router: (<><rect x="2" y="14" width="20" height="6" rx="1"/><line x1="6" y1="14" x2="6" y2="8"/><line x1="12" y1="14" x2="12" y2="4"/><line x1="18" y1="14" x2="18" y2="8"/><circle cx="6" cy="17" r="0.6" fill="currentColor"/><circle cx="10" cy="17" r="0.6" fill="currentColor"/></>),
  fridge: (<><rect x="5" y="2" width="14" height="20" rx="1.5"/><line x1="5" y1="10" x2="19" y2="10"/><line x1="8" y1="6" x2="8" y2="8"/><line x1="8" y1="14" x2="8" y2="16"/></>),
  washer: (<><rect x="3" y="3" width="18" height="18" rx="1.5"/><circle cx="12" cy="14" r="5"/><circle cx="7" cy="7" r="0.7" fill="currentColor"/></>),
  bulb: (<><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c1 .8 2 2 2 3.3h4c0-1.3 1-2.5 2-3.3A7 7 0 0 0 12 2z"/></>),
  plug: (<><path d="M9 7V3"/><path d="M15 7V3"/><path d="M5 11h14v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z"/></>),
  microwave: (<><rect x="2" y="4" width="20" height="15" rx="1"/><line x1="14" y1="4" x2="14" y2="19"/><circle cx="18" cy="9" r="0.6" fill="currentColor"/><line x1="16.5" y1="13" x2="19.5" y2="13"/></>),
  bot: (<><circle cx="12" cy="13" r="8"/><circle cx="12" cy="13" r="3.5"/><circle cx="12" cy="13" r="0.9" fill="currentColor"/></>),
  camera: (<><rect x="2" y="6" width="14" height="12" rx="1.5"/><circle cx="9" cy="12" r="3"/><polygon points="22,8 16,12 22,16"/></>),
  soundbar: (<><rect x="2" y="9" width="20" height="6" rx="1"/><circle cx="6" cy="12" r="0.6" fill="currentColor"/><circle cx="10" cy="12" r="0.6" fill="currentColor"/><circle cx="14" cy="12" r="0.6" fill="currentColor"/><circle cx="18" cy="12" r="0.6" fill="currentColor"/></>),
  stb: (<><rect x="3" y="8" width="18" height="8" rx="1"/><circle cx="18" cy="12" r="0.7" fill="currentColor"/><line x1="6" y1="12" x2="9" y2="12"/></>),

  "arrow-right": (<><path d="M5 12h14"/><path d="M13 5l7 7-7 7"/></>),
  "arrow-left": (<><path d="M19 12H5"/><path d="M11 5l-7 7 7 7"/></>),
  "arrow-up-right": (<><path d="M7 17L17 7"/><path d="M8 7h9v9"/></>),
  check: (<path d="M5 12.5l4.5 4.5L19 7.5"/>),
  x: (<><path d="M6 6l12 12"/><path d="M18 6l-12 12"/></>),
  plus: (<><path d="M12 5v14"/><path d="M5 12h14"/></>),
  search: (<><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></>),
  settings: (<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></>),
  "chevron-down": (<path d="M6 9l6 6 6-6"/>),
  "chevron-right": (<path d="M9 6l6 6-6 6"/>),
  copy: (<><rect x="9" y="9" width="11" height="11" rx="1"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></>),
  download: (<><path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/></>),
  external: (<><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></>),
  info: (<><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.7" fill="currentColor"/></>),
  warn: (<><path d="M12 3 2.5 20h19z"/><path d="M12 10v5"/><circle cx="12" cy="18" r="0.7" fill="currentColor"/></>),
  zap: (<path d="M14 3 5 14h6l-1 8 9-12h-6z"/>),
};

export interface IconProps extends React.SVGAttributes<SVGSVGElement> {
  name: IconName;
  size?: number | string;
  /** stroke width — defaults to 1.4 to match the rest of the system */
  strokeWidth?: number;
}

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.4,
  className,
  ...rest
}: IconProps) {
  const body = PATHS[name];
  if (!body) return null;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {body}
    </svg>
  );
}

export default Icon;
