/* ────────────────────────────────────────────────────────────────────────
   conet · theme runtime
   - get/set/observe the active theme
   - persist to localStorage under a single key
   - default: "dark" (Industrial Mesh fits the dark surface best)

   This module is shared by all 4 frontends. Inline-snippet variant for
   flash-of-wrong-theme prevention is exported as `THEME_INIT_SNIPPET`
   below — drop it into the <head> *before* any stylesheet links.
   ──────────────────────────────────────────────────────────────────────── */

import * as React from "react";

export type Theme = "dark" | "light" | "ivory";

export const THEME_STORAGE_KEY = "conet:theme";
export const DEFAULT_THEME: Theme = "dark";
export const THEMES: readonly Theme[] = ["dark", "light", "ivory"] as const;

export function isTheme(v: unknown): v is Theme {
  return v === "dark" || v === "light" || v === "ivory";
}

export function getTheme(): Theme {
  if (typeof document === "undefined") return DEFAULT_THEME;
  const attr = document.documentElement.getAttribute("data-theme");
  if (isTheme(attr)) return attr;
  try {
    const ls = localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(ls)) return ls;
  } catch {
    /* localStorage unavailable (private mode, file://) — fall through */
  }
  return DEFAULT_THEME;
}

export function setTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* swallow — view-only mode is acceptable */
  }
  try {
    window.dispatchEvent(new CustomEvent("conet:theme", { detail: theme }));
  } catch {
    /* very old runtimes only */
  }
}

/** React hook returning the current theme + a setter. */
export function useTheme(): readonly [Theme, (t: Theme) => void] {
  const [theme, setStateTheme] = React.useState<Theme>(() => getTheme());

  React.useEffect(() => {
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<Theme>).detail;
      if (isTheme(next)) setStateTheme(next);
    };
    window.addEventListener("conet:theme", onChange);
    return () => window.removeEventListener("conet:theme", onChange);
  }, []);

  const update = React.useCallback((t: Theme) => {
    setTheme(t);
    setStateTheme(t);
  }, []);

  return [theme, update] as const;
}

/* ────────────────────────────────────────────────────────────────────────
   Inline snippet for index.html / Electron renderer.
   Paste with <script> tag in <head> *before* CSS links to set
   data-theme synchronously and avoid a flash on first paint.
   ──────────────────────────────────────────────────────────────────────── */
export const THEME_INIT_SNIPPET = /* js */ `
(function(){
  try{
    var k='${THEME_STORAGE_KEY}';
    var t=localStorage.getItem(k);
    if(t!=='dark'&&t!=='light'&&t!=='ivory') t='${DEFAULT_THEME}';
    document.documentElement.setAttribute('data-theme', t);
  } catch(e) {
    document.documentElement.setAttribute('data-theme','${DEFAULT_THEME}');
  }
})();
`.trim();

/* ────────────────────────────────────────────────────────────────────────
   ThemeSwitcher React component — three-state segmented mono control.
   Renders three pressable buttons. Style via .c-theme-switch in
   primitives.css.
   ──────────────────────────────────────────────────────────────────────── */
export interface ThemeSwitcherProps {
  className?: string;
  label?: string;
}

export function ThemeSwitcher({ className, label = "Theme" }: ThemeSwitcherProps) {
  const [theme, set] = useTheme();
  return (
    <div role="group" aria-label={label} className={"c-theme-switch " + (className ?? "")}>
      {THEMES.map((t) => (
        <button
          key={t}
          type="button"
          aria-pressed={theme === t}
          onClick={() => set(t)}
        >
          {t}
        </button>
      ))}
    </div>
  );
}
