# conet · design system

The shared visual language for every conet frontend. **Concept C — Industrial Mesh.**

- One signal color: `--signal: #B6FF1A` (Voltage Lime)
- Two themes: `dark` (default), `light`
- Mono-heavy typography (system mono stack first, no font binaries shipped yet)
- Zero box-shadows; 1px hairlines; signal-only accent
- Eight-pixel base grid; radii 0 / 2px / 8px

## Files

| File | Used for |
|---|---|
| `tokens.css` | CSS variables (theme palettes, spacing, typography scale, motion) |
| `base.css`   | Reset, html/body defaults, focus halo, scrollbar, paper grain |
| `primitives.css` | `.c-btn`, `.c-surface`, `.c-field`, `.c-pill`, `.c-h-*`, etc. |
| `fonts/fonts.css` | (placeholder) `@font-face` block for shipping woff2 if/when we want pixel parity |
| `icons/sprite.svg` | 30 monoline icons (16 device + 14 UI) — referenced via `<use href="...#i-name"/>` |
| `icons/Icon.tsx` | React equivalent that inlines path data (no external file load) |
| `brand/logo-mark.svg` | 3×3 mesh node grid with one lime signal node |
| `brand/wordmark.svg` | Mark + lowercase "conet" wordmark |
| `brand/favicon.svg` | 32×32 dark square version, color-fixed |
| `brand/og-image.svg` | 1200×630 social card |
| `theme.tsx` | React: `useTheme()`, `setTheme()`, `<ThemeSwitcher/>`, `THEME_INIT_SNIPPET` |
| `theme.js` | Plain JS equivalent for static HTML targets (auto-binds `[data-theme-switch]`) |

## Wiring it up

### React app (`electromesh-consumer`, `electromesh-enterprise`)

```ts
// src/renderer/main.tsx
import "../../../design/tokens.css";
import "../../../design/fonts/fonts.css";
import "../../../design/base.css";
import "../../../design/primitives.css";

import { setTheme, getTheme } from "../../../design/theme";
```

In `index.html`, **before** the script tag:

```html
<script>/* paste THEME_INIT_SNIPPET here, or import and write it in build */</script>
```

Or import-and-inline at build time via Vite's `transformIndexHtml` if you prefer.

### Static HTML (`electromesh-landing`, `electromesh-phone-agent`)

```html
<head>
  <!-- 1. flash-prevention: must be first -->
  <script>
    (function(){try{var t=localStorage.getItem('conet:theme');
    if(t!=='dark'&&t!=='light')t='dark';
    document.documentElement.setAttribute('data-theme',t);}catch(e){}})();
  </script>
  <!-- 2. design system -->
  <link rel="stylesheet" href="/design/tokens.css">
  <link rel="stylesheet" href="/design/fonts/fonts.css">
  <link rel="stylesheet" href="/design/base.css">
  <link rel="stylesheet" href="/design/primitives.css">
  <link rel="icon" type="image/svg+xml" href="/design/brand/favicon.svg">
  <!-- 3. theme runtime (auto-binds [data-theme-switch]) -->
  <script defer src="/design/theme.js"></script>
</head>
```

A theme switcher in markup:

```html
<div class="c-theme-switch" data-theme-switch role="group" aria-label="Theme">
  <button type="button" data-theme-value="dark">dark</button>
  <button type="button" data-theme-value="light">light</button>
</div>
```

## Class naming convention

All conet classes are prefixed `c-`. Apps may add their own `app-*` or
local CSS Module classes for page-specific layouts. **Never** use Tailwind
or unprefixed utility classes.

## Where the brand stops and the backend begins

- **Frontend / user-facing:** `conet`
- **Backend / repo / appId / API host:** `electromesh` (unchanged)
