# Tasks — Add Collapsible Projects Section

- [x] Add a persisted `projectsCollapsed` flag to the store (`types`, `core`,
      `autosave`, `persistence`) defaulting to expanded.
- [x] Add a `setProjectsCollapsed(boolean)` helper in `store/ui` that also
      drops `sidebarFocusedProjectId` when collapsing, and export it from the
      store barrel.
- [x] Make the Projects section header a toggle (chevron + label) that
      animates the list collapse smoothly via a CSS grid-rows transition, with
      hover and focus-visible styles on the toggle button.
- [x] Skip "project mode" in sidebar arrow-key navigation while collapsed so
      `↑/↓` does not walk through invisible items.
- [x] Cover the persisted flag in the persistence test suite (including
      rejection of non-boolean values).
- [x] Validate with `npm run typecheck`, `npm test`, and
      `openspec validate --all --strict`.
