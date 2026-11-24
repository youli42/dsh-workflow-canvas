# dsh-workflow-canvas — Agent Rules

Repository-level constraints and architecture map for developing `dsh-workflow-canvas`, a DeepSeek Harness (DSH) sidebar workflow canvas plugin.

> Note: `AGENTS.md` and `.agents/` are workspace dev-agent files and are excluded from npm publishing by `package.json`'s `"files"` whitelist. Do not confuse `.agents/skills/` with `skills/workflow-canvas/SKILL.md`, which is the user-facing DSH plugin skill shipped in the package.

## 1. Repository Map

- `index.js` — Backend DSH Cordis plugin: DAG/loop executor, `canvas_*` tools, `/canvas-sync` & `/canvas-stop` commands, `systemPrompt.context` builder, and `.run.json` run-state telemetry.
- `client.js` — Frontend sidebar UI (vanilla React via `h`, zero build step): canvas rendering, pan/zoom/layout (`lr` & `tb`), undo/redo, presets, `I18N` (`zh`/`en`), and `helpBody`.
- `skills/workflow-canvas/SKILL.md` — Runtime DSH plugin skill read by the host agent.
- `docs/DETAIL.md`, `docs/MECHANISM.zh.md`, `docs/MECHANISM.md`, `README.zh.md`, `README.md` — User & architecture docs.
- `locale/zh.json`, `locale/en.json` — Plugin manifest/metadata localization.
- `test/executor.test.mjs`, `test/client.test.mjs` — Node built-in test suites.

## 2. Verification & Environment

- Syntax checks: `node --check index.js` and `node --check client.js`
- Test suite: `npm test` (`node --test`)
- **`client.js` `vm` sandbox tests**: Arrays/objects returned from the `vm` context have different prototypes — unwrap them (`[...arr]`, `{ ...obj }`) before `assert.deepEqual`.
- **Windows PowerShell 5.1**:
  - Do not chain commands with `&&` (use `;` or check `$LASTEXITCODE`).
  - Pass Chinese text to `gh` CLI via UTF-8 files (`--body-file` / `--notes-file`), never inline quoted args.
  - When loading UTF-8 text in PowerShell for JSON serialization, use `[System.IO.File]::ReadAllText(path, [System.Text.Encoding]::UTF8)` (not `Get-Content -Raw`, which attaches PSObject metadata).

## 3. DSH Host API Contract (Zero Guessing)

**Never guess unverified DSH host method names, parameter shapes, or `ctx.remote` namespaces.** If a host capability is uncertain, stop and give the user concise, targeted questions to verify against the installed DSH `app.asar` source before writing code.

### Source-Verified DSH 0.2.2-rc.5 APIs

| Layer | Verified API | Contract / Constraints |
| :--- | :--- | :--- |
| Client `ISession` (`ctx.sessions.binding(sid).session`) | `cancel()` | No args. Cancels running turn (`keepInbox: true`). **Root session only** — throws `apiSessionSubagentOwnershipError` on subagents. |
| Client `ctx.remote.session` | `cancel({ sessionId })` | Object argument. Root session only. |
| Client `ctx.remote.subagents` | `interruptByUser(childSessionId)` | Interrupts a live child subagent. |
| Host `ctx.subagents` | `interrupt(childSessionId, { kind: 'user' })` | Fire-and-return interrupt for a live child. (`startActivation({ signal })` only aborts startup, not post-start execution.) |
| Host `ctx.subagents` | `drainDescendants([rootAgent])` | Tears down the entire descendant subtree; fire-and-forget when returning to UI to avoid provider stalls. |
| Host root `Agent` (`invocation.agent` / `ctx.agents.get(sid)`) | `cancel({ kind: 'user' }, { keepInbox: true })` | Cancels root turn. (`ctx.sessions.get(sid)` is only a log/projection registry and has no `cancel`.) |
| Commands (`session.command('/cmd')`) | Concurrent immediate execution | Runs immediately even while a turn is active (does not queue) and receives the exact root `agent`. |

- **Backward compatibility**: Lazily resolve optional `ctx.remote.*` namespaces at call time instead of adding hard entries to `package.json` `dsh.client.inject`, so older hosts never fail to mount the plugin.

## 4. Core Codebase Invariants

- **`keepMounted` session isolation**:
  - `WorkflowCanvas` must remain keyed by `sessionId` so switching sessions never cross-writes another session's storage.
  - Native `storage` events do not fire across tabs in the same Electron window; cross-tab state (e.g. presets) must broadcast a same-window `CustomEvent` and merge fresh storage before writes/deletes.
- **Authoritative `.run.json` telemetry**:
  - Backend writes terminal/paused states (`halted`, `done`, `idle`, `need-lead`) to `.run.json`.
  - Frontend `deriveLeadStatuses` must treat authoritative `runState.status` as source of truth so stopped/completed runs never falsely re-lock into `Awaiting Lead` from historical subagent statuses.
- **Abort safety & zero zombies**:
  - Guard `signal && signal.aborted` before every subagent activation, warm retry, `session-ref` / `keepSession` fallback, and `fallbackModel` retry.
  - When aborting from `canvas_workflow({ cancel: true })`, pass `cancelRootTurn: false` so the model's own cancellation reply is not cut off.
- **Condition & Loop invariants**:
  - Condition nodes are always forced to `preset: 'minimal'` and excluded from writable standard agent counts (`stdCount` / `hasStandardAgent`).
  - Loop retries must un-prune previously pruned outside descendants reachable from loop members so inner condition branch switches execute on retry rounds.
  - Loop validation must check full-graph runtime loop membership (`descendants(entry) ∩ ancestors(exit)`) for overlap, not just the UI selection.
  - Use `O(V + E)` index cursors instead of `queue.shift()` in graph traversals.
- **Dual-direction & bilingual UI**:
  - Every UI change must be checked in both horizontal (`lr`) and vertical (`tb`) layouts and in both `zh` and `en` (longer English labels must not collide with socket labels or badges).
  - Lift cards to elevated `zIndex` while any popover/dropdown is open.

## 5. Cross-File Sync Matrix

When adding or changing features, node fields, tools, commands, or UI controls, keep all affected surfaces in sync:

1. **Agent runtime surface (`index.js`)**: `buildActiveCanvasContext`, tool schemas/descriptions, and tool `render()` outputs (`canvas_inspect`, `canvas_workflow`, `canvas_patch`, `canvas_generate`).
2. **Client UI & serialization (`client.js`)**: `I18N` (`zh`/`en`), `helpBody` (`zh`/`en`), `buildPlan`, `applyCanvasDoc` (including remote field deletion cleanup), presets, and JSON import/export.
3. **Docs & metadata**: `README.zh.md`, `README.md`, `docs/DETAIL.md`, `docs/MECHANISM.zh.md`, `docs/MECHANISM.md`, `skills/workflow-canvas/SKILL.md`, `locale/zh.json`, `locale/en.json`, `package.json` `description`.
4. **Tests**: Cover new backend logic in `test/executor.test.mjs` and client helpers in `test/client.test.mjs`.

For major changes or before cutting a release, activate the `pre-release-audit` skill (`.agents/skills/pre-release-audit/SKILL.md`).

## 6. Git & Release Hard Rules

- **NEVER run `git add .` or `git add -A`**: local untracked directories (such as local runtime data or scratch folders) must stay untracked. Always stage explicit file paths.
- **NEVER run `npm publish` directly**: complete tests, commit, tag, push, GitHub issue replies/closures, and GitHub Release, then output the exact publish command for the user using the active workspace path:
  ```cmd
  cd /d <repo-root> && npm publish
  ```
- **GitHub Issues & Releases**:
  - Always comment on each resolved issue (via UTF-8 `--body-file`) **before** closing it (`--reason completed`).
  - Always publish **bilingual (zh + en)** GitHub Release notes via `--notes-file`.
