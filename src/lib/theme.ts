import { colord } from 'colord';
import type { LookPreset } from './look';
import { CSS_VARS } from './custom-theme';
import type { CssVar } from './custom-theme';

/** Theme tokens referencing CSS variables defined in styles.css */
export const theme = {
  // Backgrounds (3-tier: black → task columns → panels inside)
  bg: 'var(--bg)',
  bgElevated: 'var(--bg-elevated)',
  bgInput: 'var(--bg-input)',
  bgHover: 'var(--bg-hover)',
  bgSelected: 'var(--bg-selected)',
  bgSelectedSubtle: 'var(--bg-selected-subtle)',

  // Borders
  border: 'var(--border)',
  borderSubtle: 'var(--border-subtle)',
  borderFocus: 'var(--border-focus)',

  // Text
  fg: 'var(--fg)',
  fgMuted: 'var(--fg-muted)',
  fgSubtle: 'var(--fg-subtle)',

  // Accent
  accent: 'var(--accent)',
  accentHover: 'var(--accent-hover)',
  accentText: 'var(--accent-text)',
  link: 'var(--link)',

  // Semantic
  success: 'var(--success)',
  error: 'var(--error)',
  warning: 'var(--warning)',

  // Island containers (task columns, sidebar)
  islandBg: 'var(--island-bg)',
  islandBorder: 'var(--island-border)',
  islandRadius: 'var(--island-radius)',
  taskContainerBg: 'var(--task-container-bg)',
  taskPanelBg: 'var(--task-panel-bg)',
} as const;

/** Opaque terminal background per preset — matches --task-panel-bg */
export const terminalBackground: Record<LookPreset, string> = {
  classic: '#2d2e32',
  graphite: '#1c2630',
  midnight: '#000000',
  indigo: '#1c2038',
  ember: '#211918',
  glacier: '#232e3a',
  minimal: '#252520',
  zenburnesque: '#2e2d2a',
  'catppuccin-mocha': '#1e1e2e',
  'islands-dark': '#181a1d',
  'islands-light': '#ffffff',
  workbench: '#1f1f1f',
};

/**
 * Returns an xterm-compatible theme object for the given preset.
 * For light-background presets we override xterm's defaults (white text,
 * white-ish bright ANSI palette) so plain output stays readable.
 */
export function getTerminalTheme(preset: LookPreset) {
  if (preset === 'islands-light') {
    return {
      background: '#ffffff',
      foreground: '#1f2329',
      cursor: '#1f2329',
      cursorAccent: '#ffffff',
      selectionBackground: '#cfe1ff',
      // GitHub-light-ish ANSI palette so colored output (claude prompts,
      // ls --color, git status) stays legible on white.
      black: '#24292e',
      red: '#cf222e',
      green: '#116329',
      yellow: '#8a6d00',
      blue: '#0550ae',
      magenta: '#8250df',
      cyan: '#1b7c83',
      white: '#6e7781',
      brightBlack: '#57606a',
      brightRed: '#a40e26',
      brightGreen: '#1a7f37',
      brightYellow: '#633c01',
      brightBlue: '#0969da',
      brightMagenta: '#6639ba',
      brightCyan: '#3192aa',
      brightWhite: '#1f2329',
    };
  }
  return {
    background: terminalBackground[preset],
  };
}

/**
 * Reads all CSS custom property values for a built-in preset by temporarily
 * switching data-look on the root element. No repaint occurs between the switch
 * and restore since getComputedStyle is synchronous within a single JS task.
 */
export function readCssVarsForPreset(presetId: string): Partial<Record<CssVar, string>> {
  const el = document.documentElement;
  const savedLook = el.dataset.look;
  const savedCustomTheme = el.dataset.customTheme;
  // Suppress the active custom-theme overlay so computed vars come from the
  // built-in preset alone, not from any custom stylesheet on top of it.
  const styleEl = document.getElementById('custom-theme-style') as HTMLStyleElement | null;
  const savedStyleContent = styleEl?.textContent ?? null;

  el.dataset.look = presetId;
  delete el.dataset.customTheme;
  if (styleEl) styleEl.textContent = '';

  const style = getComputedStyle(el);
  const result: Partial<Record<CssVar, string>> = {};
  for (const v of CSS_VARS) {
    const val = style.getPropertyValue(v).trim();
    if (val) result[v as CssVar] = val;
  }

  if (savedLook !== undefined) {
    el.dataset.look = savedLook;
  } else {
    delete el.dataset.look;
  }
  if (savedCustomTheme !== undefined) {
    el.dataset.customTheme = savedCustomTheme;
  }
  if (styleEl && savedStyleContent !== null) styleEl.textContent = savedStyleContent;

  return result;
}

/** Returns an xterm-compatible theme object for a custom theme. */
export function getTerminalThemeForCustom(bg: string) {
  const isLight = (() => {
    try {
      return colord(bg).luminance() > 0.5;
    } catch {
      return false;
    }
  })();

  if (isLight) {
    return {
      background: bg,
      foreground: '#1f2329',
      cursor: '#1f2329',
      cursorAccent: '#ffffff',
      selectionBackground: '#cfe1ff',
      black: '#24292e',
      red: '#cf222e',
      green: '#116329',
      yellow: '#8a6d00',
      blue: '#0550ae',
      magenta: '#8250df',
      cyan: '#1b7c83',
      white: '#6e7781',
      brightBlack: '#57606a',
      brightRed: '#a40e26',
      brightGreen: '#1a7f37',
      brightYellow: '#633c01',
      brightBlue: '#0969da',
      brightMagenta: '#6639ba',
      brightCyan: '#3192aa',
      brightWhite: '#1f2329',
    };
  }
  return { background: bg };
}

/** Generates a styled banner (warning/error/info) using color-mix for background+border. */
export function bannerStyle(color: string): Record<string, string> {
  return {
    color,
    background: `color-mix(in srgb, ${color} 8%, transparent)`,
    padding: '8px 12px',
    'border-radius': '8px',
    border: `1px solid color-mix(in srgb, ${color} 20%, transparent)`,
  };
}

/** Shared style for uppercase section label headings in dialogs. */
export const sectionLabelStyle: Record<string, string> = {
  'font-size': '12px',
  color: 'var(--fg-muted)',
  'text-transform': 'uppercase',
  'letter-spacing': '0.05em',
};
