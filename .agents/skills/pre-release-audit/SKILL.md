---
name: pre-release-audit
description: >-
  Six-pass deep engineering audit for dsh-workflow-canvas covering host API and
  agent-context alignment, cross-file synchronization, dead code and algorithm
  correctness, breaking changes, UI overlap or regression risks, and high-value
  invariant comments. Use this skill before cutting a release, after completing
  major features or multi-issue fixes, or when the user asks to deep-audit,
  hunt for hidden bugs, check regressions, or review before release.
---

# Pre-Release Deep Audit

Run a rigorous, evidence-backed 6-pass audit of pending changes in `dsh-workflow-canvas`.

## Operating Principle

**Never collapse all 6 passes into one superficial skim.** Execute each pass with a dedicated focus (sequentially pass-by-pass, or via parallel read-only research subagents assigned one pass each), and require concrete `file:line` evidence for every claim.

- If an issue is found, fix it cleanly and add/update unit tests covering the regression.
- If a DSH host API signature cannot be confirmed from the repo or `AGENTS.md`, **do not guess** — collect precise questions for the user to verify against the installed DSH `app.asar` source.

---

## Pass 1 — Host API Contract & Agent Context Alignment

1. Inspect every DSH host/client API call touched in `index.js` and `client.js`:
   - Confirm exact method names, argument shapes (e.g., `remote.session.cancel({ sessionId })`), and ownership boundaries (never call `session.cancel` on subagents; use `subagents.interrupt` / `remote.subagents.interruptByUser`).
   - Confirm optional `ctx.remote.*` namespaces are resolved lazily rather than added as hard `dsh.client.inject` dependencies.
2. Inspect Agent-facing runtime context in `index.js`:
   - `buildActiveCanvasContext`: does it reflect all active graph features (loops, global/node refs, `waitingLead`, `cancel: true`, updated patch keywords)?
   - Tool descriptions, parameter schemas, and `render()` outputs (`canvas_inspect`, `canvas_workflow`, `canvas_patch`, `canvas_generate`): are newly added fields/statuses rendered accurately?
   - `SKILL_DESCRIPTION` and `skills/workflow-canvas/SKILL.md`: do they match actual runtime behavior?

## Pass 2 — Cross-File Synchronization

Compare `git diff` across all functional surfaces and verify nothing drifted out of sync:

- `index.js` ↔ `client.js` (node schema, edge types, condition/loop fields, `.run.json` statuses, commands)
- `client.js` `I18N.zh` ↔ `I18N.en` (key parity, accurate wording) and `helpBody` (`zh` & `en`)
- `README.zh.md` ↔ `README.md`
- `docs/DETAIL.md`, `docs/MECHANISM.zh.md`, `docs/MECHANISM.md`
- `skills/workflow-canvas/SKILL.md`
- `locale/zh.json` ↔ `locale/en.json`
- `package.json` (`description`, `files`, `engines.dsh`)

Verify all JSON files parse without error and all relative markdown links in README/docs point to existing files.

## Pass 3 — Dead Code & Algorithm / State-Machine Correctness

1. **Dead code scan** (verify via search across `index.js` and `client.js`):
   - Unused `S.*` style definitions
   - Unused `I18N` keys
   - Unused helper functions, refs, timers, or unreachable branches left behind by refactors
2. **Algorithm & concurrency audit**:
   - Graph traversals (`orderNodes`, `topoOrder`, `wouldCycle`, reachability): verify `O(V + E)` index cursors (no `Array.shift()` loops), cycle rejection, and entry-Lead handling.
   - Controlled loops + conditions: verify retry rounds reset/un-prune downstream nodes reachable from loop members, loop body overlap checks full-graph membership, and deleting a branch/node prunes broken loops.
   - Cancellation & async races: verify `AbortSignal` is checked before every spawn/warm-retry/fallback, `Promise.race` unblocks hung activations immediately, partial results preserve into `lastRunBySession`, and stale `.run.json` cannot survive after abort/restart.
   - Catalog / status derivation: verify `running` stays sticky over historical retry entries and `deriveLeadStatuses` honors authoritative `.run.json` states.

## Pass 4 — Breaking Changes & Backward Compatibility

1. **Stored data migration**:
   - Old `localStorage` canvas documents, presets, direction settings, and custom shortcuts missing newly added fields must load cleanly with safe defaults.
   - Exported JSON from older versions must import without error; new optional fields must remain optional.
2. **Remote merge vs. delete semantics**:
   - In `applyCanvasDoc` (`merge && fromRemote`), verify fields intentionally removed by `canvas_patch` (e.g., `refs`, `branches`, `multiMatch`) are cleared instead of staying stale, while preserving local visual/layout state.
3. **Public & host compatibility**:
   - Check `package.json` `exports`, `files`, `engines.dsh`, and `dsh.client.inject` for unintended breaking changes.

## Pass 5 — UI Regressions, Pixel Overlap & Concurrency Hazards

Inspect `client.js` layout, positioning, and event handling across all combinations:

- **Directions**: both horizontal (`lr`) and vertical (`tb`)
- **Locales**: both `zh` and `en` (check longer English strings like `session`, `Awaiting Lead`, `Stop`)
- **Geometry & overlap**:
  - Entry Lead status badge + Stop button vs. socket labels
  - Warning chips / floating overlays vs. bottom bar in `tb` and `lr`
  - Tall condition cards or multi-branch nodes in `layoutGraph('lr')` and `layoutGraph('tb')`
  - `fitView` padding when loop bypass arcs exist
  - Card `zIndex` elevation when any popover, model picker, or dropdown is open; mutual exclusion when opening toolbar menus (`☰ 预设`, `⋯`, loop editor)
- **Interactive concurrency**:
  - Simultaneous pan drag + wheel zoom (incremental pan step, no snap-back)
  - Active drags / zoom scrub cleared on `window.blur`
  - Node click vs. drag undo snapshot threshold (`> 0.5px`)
  - Multi-session `keepMounted` switching (`key={sessionId}`) and same-window preset sync

## Pass 6 — High-Value Invariant Comments

Review newly added or modified tricky logic in `index.js` and `client.js`:

- Add concise comments **only** where a future reader/agent could easily break a non-obvious invariant, host quirk, concurrency race, or cross-layer contract.
- Do not add noisy comments explaining self-evident code.

---

## Final Verification Gate

After completing all fixes across Passes 1–6, run in one verification batch:

1. `node --check index.js` and `node --check client.js`
2. Parse all `.json` files (`package.json`, `locale/zh.json`, `locale/en.json`) and validate local doc links
3. `npm test` (all tests must pass; add regression tests for every bug found)
4. `git status --short` (confirm no local untracked directories are staged)

Summarize the audit by pass:
- **Fixed**: concrete findings with clickable `file://` links
- **Verified Clean**: dimensions checked with no remaining defects
- **Open Questions**: any unverified host API or product decision needing user input
