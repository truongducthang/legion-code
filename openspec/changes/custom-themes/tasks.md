# Tasks — Custom Themes

- [x] Add `CustomTheme` type and CSS parse/serialize helpers in
      `src/lib/custom-theme.ts` (`parseThemeCss`, `themeToCss`,
      `buildCustomThemeCss`, `detectThemeTone`, `generateThemePrompt`,
      `checkThemeContrast`).
- [x] Add IPC channels `load_custom_themes`, `save_custom_theme`,
      `delete_custom_theme` to `electron/ipc/channels.ts`, implement handlers
      in `electron/ipc/persistence.ts`, register in `electron/ipc/register.ts`,
      and allowlist in `electron/preload.cjs`.
- [x] Persist custom themes as `~/.config/parallel-code/themes/<id>.css` files;
      load via `loadCustomThemes()` in `src/store/persistence.ts`.
- [x] Add store fields: `appearanceMode`, `lightThemePreset`, `darkThemePreset`,
      `lightThemeCustomId`, `darkThemeCustomId`, `activeCustomThemeId`,
      `customThemes` to `src/store/types.ts` and `src/store/core.ts`.
- [x] Add `Appearance` settings tab (Light / Dark / System mode selector) and
      merge custom themes into the built-in preset grid in
      `src/components/SettingsDialog.tsx`.
- [x] Add `CustomThemeDialog.tsx` with CSS paste area, live validation, WCAG AA
      contrast warnings, AI prompt template, and delete button.
- [x] Apply active custom theme via `data-custom-theme` attribute on
      `<html>` in `src/App.tsx`; preserve `data-look` for structural rules.
- [x] Wire terminal background to active custom theme in
      `src/components/TerminalView.tsx`; handle light custom themes with
      appropriate ANSI palette in `getTerminalThemeForCustom`.
- [x] Add `applyAppearanceMode()` store action and call it after
      `loadCustomThemes()` on startup.
- [x] Migrate any `customThemes` entries found in `state.json` (from pre-CSS
      builds) to individual CSS files on load; remove `customThemes` from
      `saveAppState()` output.
- [x] Update unit tests in `src/lib/custom-theme.test.ts` and
      `src/store/appearance-mode.test.ts`.
- [ ] Validate with `npm run typecheck`, `npm test`, and
      `openspec validate --all --strict`.
