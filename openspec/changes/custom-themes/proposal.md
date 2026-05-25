# Custom Themes

## Why

Users cannot currently personalize the app's color scheme beyond choosing a
built-in preset. Sharing or adapting themes created by others requires editing
source files. There is no path to light/dark-aware theming for users who prefer
a system-matched appearance.

## What changes

- Add an **Appearance** settings tab with a Light / Dark / System mode selector.
- Add **custom themes** stored as `.css` files in the user's config directory.
  Each theme uses a standard CSS header comment for metadata (`name:`,
  `description:`, `terminalBackground:`) and `:root { }` for CSS variable
  overrides.
- Custom themes appear alongside built-in presets in the theme grid, filtered by
  auto-detected tone (luminance of `--bg-elevated`). An **Edit** hover button
  distinguishes them from built-in presets (which show **Clone**).
- A **+ Create New** button opens a dialog with a copyable AI prompt, a CSS
  paste area, live validation, and WCAG AA contrast warnings.
- The terminal emulator background respects `terminalBackground` from the active
  custom theme.
- Structural layout rules (`data-look`) are preserved when a custom theme is
  active; color variables are injected via a separate `data-custom-theme`
  attribute so cloned themes retain the base preset's chrome.

## Impact

- New IPC channels: `load_custom_themes`, `save_custom_theme`,
  `delete_custom_theme` (allowlisted in preload).
- New persistence: `~/.config/parallel-code/themes/<id>.css`.
- New store fields: `appearanceMode`, `lightThemePreset`, `darkThemePreset`,
  `lightThemeCustomId`, `darkThemeCustomId`, `activeCustomThemeId`,
  `customThemes`.
