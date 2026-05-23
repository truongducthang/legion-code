# Custom Themes Specification

## Purpose

Allow users to create, edit, share, and apply custom color schemes without
editing source files, with automatic light/dark tone detection and WCAG AA
contrast validation.

## Requirements

### Requirement: CSS theme format

Custom themes SHALL be stored as `.css` files with a mandatory header comment
and a `:root {}` block of CSS variable overrides.

#### Scenario: Valid theme is parsed

- **GIVEN** a CSS file with a `/* name: … terminalBackground: … */` header
  comment and a `:root { --bg: …; … }` block
- **WHEN** `parseThemeCss` is called with that content
- **THEN** it returns `{ name, description, terminalBackground, vars }` with no
  error

#### Scenario: Missing header comment is rejected

- **GIVEN** CSS that begins with `:root {` and has no `/* */` comment
- **WHEN** `parseThemeCss` is called
- **THEN** it throws with a message containing `"header comment block"`

#### Scenario: Missing name is rejected

- **GIVEN** a header comment that contains `terminalBackground:` but not `name:`
- **WHEN** `parseThemeCss` is called
- **THEN** it throws with a message containing `"name"`

#### Scenario: Missing terminalBackground is rejected

- **GIVEN** a header comment that contains `name:` but not `terminalBackground:`
- **WHEN** `parseThemeCss` is called
- **THEN** it throws with a message containing `"terminalBackground"`

#### Scenario: Inline comments are stripped before parsing vars

- **GIVEN** a declaration like `--bg: #0f0e17; /* App background */`
- **WHEN** `parseThemeCss` processes that block
- **THEN** `vars['--bg']` equals `'#0f0e17'` and the comment is discarded

#### Scenario: Unknown CSS variables are silently ignored

- **GIVEN** a `:root` block containing `--unknown-key: #fff`
- **WHEN** `parseThemeCss` processes it
- **THEN** `--unknown-key` does not appear in the returned `vars`

### Requirement: Theme file persistence

Custom themes SHALL be stored as individual `.css` files under
`~/.config/parallel-code/themes/<id>.css`. The `customThemes` object SHALL NOT
be written to `state.json`.

#### Scenario: Save creates a CSS file

- **WHEN** the renderer sends `save_custom_theme` with a valid `id` and `css`
- **THEN** the main process writes `<configDir>/themes/<id>.css` with that content

#### Scenario: Load returns all CSS files

- **WHEN** the renderer sends `load_custom_themes`
- **THEN** the main process returns an array of `{ id, css }` for every `.css`
  file in the themes directory

#### Scenario: Delete removes the file

- **WHEN** the renderer sends `delete_custom_theme` with an `id`
- **THEN** the main process removes `<configDir>/themes/<id>.css`

#### Scenario: Path traversal is rejected

- **WHEN** `save_custom_theme` or `delete_custom_theme` is called with an `id`
  that contains characters outside `[a-zA-Z0-9_-]`
- **THEN** the main process throws an error and does not touch the filesystem

### Requirement: Tone detection and theme grid integration

Custom themes SHALL appear in the same preset grid as built-in themes,
filtered by auto-detected tone (light or dark).

#### Scenario: Dark custom theme appears in dark slot

- **GIVEN** a custom theme whose `--bg-elevated` has luminance ≤ 0.5
- **WHEN** the Themes settings tab is shown in dark appearance mode
- **THEN** the theme card appears in the dark preset grid

#### Scenario: Light custom theme appears in light slot

- **GIVEN** a custom theme whose `--bg-elevated` has luminance > 0.5
- **WHEN** the Themes settings tab is shown in light appearance mode
- **THEN** the theme card appears in the light preset grid

#### Scenario: Custom cards show Edit; built-in cards show Clone

- **GIVEN** a mix of built-in and custom theme cards in the grid
- **WHEN** the user hovers a custom card
- **THEN** an **Edit** button is shown (not Clone)
- **AND WHEN** the user hovers a built-in card
- **THEN** a **Clone** button is shown

### Requirement: Structural layout preservation

The `data-look` HTML attribute SHALL always reflect the active base preset so
that structural CSS rules (layout, spacing, radius) are never lost when a
custom theme overrides color variables.

#### Scenario: Custom theme does not clobber data-look

- **GIVEN** a built-in preset `indigo` is selected and a custom theme is active
- **WHEN** the app renders
- **THEN** `document.documentElement.dataset.look` equals `"indigo"`
- **AND** `document.documentElement.dataset.customTheme` equals the custom
  theme's `id`

### Requirement: Terminal readability for light custom themes

When a custom theme's `terminalBackground` has luminance > 0.5, the terminal
emulator SHALL use a dark foreground color and a GitHub-light-compatible ANSI
palette so that colored output remains legible.

#### Scenario: Light background gets dark foreground

- **GIVEN** a custom theme with `terminalBackground: #ffffff`
- **WHEN** `getTerminalThemeForCustom` is called with that value
- **THEN** the returned object includes `foreground: '#1f2329'`

#### Scenario: Dark background gets default foreground

- **GIVEN** a custom theme with `terminalBackground: #1e1e2e`
- **WHEN** `getTerminalThemeForCustom` is called
- **THEN** the returned object does NOT include a `foreground` key

### Requirement: WCAG AA contrast validation

The theme dialog SHALL report contrast warnings for pairs that fail WCAG AA
thresholds so users can correct them before saving.

#### Contrast pairs checked

| Foreground      | Background      | Required ratio |
| --------------- | --------------- | -------------- |
| `--fg`          | `--bg-elevated` | 4.5 : 1        |
| `--fg-muted`    | `--bg-elevated` | 3.0 : 1        |
| `--fg`          | `--bg-selected` | 4.5 : 1        |
| `--accent-text` | `--accent`      | 4.5 : 1        |

Translucent backgrounds SHALL be composited over `--bg-elevated` before the
ratio is computed to avoid false positives.
