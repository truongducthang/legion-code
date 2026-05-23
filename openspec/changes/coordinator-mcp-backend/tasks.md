# Tasks - Coordinator MCP Backend

- [x] Add coordinator registration, deregistration, and per-coordinator task
      tracking in the main process.
- [x] Expose coordinator MCP tools for creating, listing, prompting, waiting,
      diffing, merging, reviewing, closing, and signaling sub-tasks.
- [x] Add remote API routes with scoped coordinator, sub-task, and mobile token
      behavior.
- [x] Generate per-sub-task MCP config files with restrictive file modes and
      pass them explicitly to spawned agents.
- [x] Inject and strip sub-task preamble blocks for Claude, Codex, Gemini, and
      supported agent config files.
- [x] Preserve orphaned child task MCP config paths until the child task is
      closed.
- [x] Reject manual remote-server rebinding while coordinator-owned or orphaned
      coordinated tasks are live.
- [x] Keep the manual remote server bound to loopback by default.
- [x] Persist coordinator metadata and restore task grouping after restart.
- [x] Cover sidebar grouping for coordinated children and orphaned children.
- [x] Cover coordinator review status and coordinated auto-trust behavior.
- [x] Move Docker shared-auth Claude trust seeding off synchronous filesystem
      calls in the spawn setup path.
- [ ] Run `openspec validate --all --strict` (blocked locally: `npx openspec`
      cannot determine an executable).
- [x] Run focused coordinator, IPC, PTY, and store tests.
- [x] Run `npm run compile`, `npm run typecheck`, and `git diff --check`.
