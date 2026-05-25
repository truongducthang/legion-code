# Add Collapsible Projects Section

## Why

The sidebar **Projects** section is always expanded and always occupies a
capped slice of vertical space (`40vh`, or `min(24vh, 180px)` when dense),
becoming its own scroll area when there are many projects. Users who keep many
projects but spend most of their time in the tasks list pay that fixed space
even when they are not switching projects.

## What changes

- Add a collapse/expand toggle to the **Projects** section header: clicking the
  header (or its chevron) hides the project list entirely and reclaims the
  space for the tasks section.
- Show a chevron on the header that reflects collapsed vs. expanded state.
- Persist the collapsed state via the existing settings persistence so it
  survives app restarts.

## Impact

- New capability `sidebar`.
- Updates `src/components/Sidebar.tsx`; adds a persisted `projectsCollapsed`
  flag to the store (`types`, `core`, `autosave`, `persistence`, `ui`).
- No backend or IPC change — the flag rides the existing persisted-state file.
