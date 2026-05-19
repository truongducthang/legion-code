# Tasks — Add Mobile Spawn Task

- [ ] Extend `electron/remote/protocol.ts`: - Add client → server messages `ListProjectsCommand`,
      `ListBranchesCommand`, `SpawnTaskCommand`. - Add server → client messages `ProjectsMessage`,
      `BranchesMessage`, `SpawnResultMessage`. - Extend `parseClientMessage` with the size caps from `design.md`. - Add a `parseSpawnError` discriminator helper so tests can assert
      on typed error codes.
- [ ] Unit tests in `electron/remote/protocol.test.ts` covering: - Oversized fields rejected. - Unknown `type` rejected. - Valid `spawn_task` round-trips.
- [ ] Extend `startRemoteServer(...)` in `electron/remote/server.ts`
      to accept three new callbacks: - `listProjects(): Promise<{ root, name, defaultBaseBranch }[]>` - `listBranches(projectRoot): Promise<{ name, current }[]>` - `spawnTask(req): Promise<SpawnResultMessage>` - Wire them into the message switch under the existing
      `authenticatedClients.has(ws)` gate. - Apply the 2 s spawn-rate floor and the one-in-flight guard.
- [ ] In `electron/ipc/register.ts`, when `startRemoteServer` is
      called, pass the three new callbacks. Implement them as thin
      wrappers around: - The persisted-state project list (already in scope when
      building the `getTaskName` callback). - A new helper `electron/ipc/git-branches.ts:listBaseBranches`
      that returns local + remote branches via the existing git
      helpers, current branch flagged. - The existing `createTask` + agent-start + initial-prompt-send
      sequence used by the desktop renderer today, called directly
      without going back through `ipcMain.handle`.
- [ ] Unit tests in `electron/remote/server.test.ts` (or extend the
      existing test file): - Unauthenticated client gets `4001` on `spawn_task`. - Invalid project / branch / agent return the typed error codes
      without filesystem effects. - Rapid duplicate spawns are throttled to one every 2 s. - On success, the new agent shows up in the next `agents`
      broadcast.
- [ ] Renderer (`src/remote/`): - `ws.ts`: add `listProjects()`, `listBranches(root)`,
      `spawnTask(req)` with promise-correlated `requestId`. - New `NewTask.tsx` screen: project select, branch select,
      agent preset radio, task name, prompt textarea, submit
      button. Submit button disabled until required fields are
      filled and not while a spawn is in flight. - `AgentList.tsx`: floating action button that opens
      `NewTask.tsx`. - `App.tsx`: route between list, detail, and new-task views.
- [ ] Style new screen consistent with existing remote screens
      (single column, large tap targets, no desktop-only widgets).
- [ ] `openspec validate --strict add-mobile-spawn-task`, `npm run
typecheck`, `npm test`.
