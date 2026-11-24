# Workflow canvas

A node-graph canvas for orchestrating DSH subagents, docked in the right
sidebar. Draw a DAG (or load a starter template), enable it, and ask the agent
to run it — subagent nodes are spawned for real, Lead nodes pause the run and
are performed by the conversation itself.

## Canvas

- **Subagent node** (green top bar): spawns a child agent with its own
  `provider` / `model` / `reasoning effort` / capability scope (`standard` or
  `minimal`, bounded by the main chat permission mode). Optional **Memory** reuses
  the node's child session (Latest or pinned past run); optional **Fallback**
  retries once on another model.
- **Lead node** (blue top bar): performed by the conversation, never spawned. The
  entry node carries the overall task; intermediate Lead nodes pause for your
  decision; `Lead → Lead` stage chains are supported with zero subagent spawns
  when `role` is filled; a terminal Lead finishes in one shot without an extra
  callback.
- **Condition node** (amber top bar): lightweight read-only (`minimal`) branch
  judge supporting inline-editable binary `if/else` (`Yes` / `No`), multi-way
  `switch/case` (`+ Case`), and `Single` / `Multi` match modes (including clean
  zero-match full skip when no branch applies). Unchosen paths are pruned
  automatically without spawning, and branches can converge back into a shared
  downstream node or terminal Lead.
- **Controlled retry loops (`↺`)**: wire a condition branch back to a strict
  ancestor (or select connected nodes and right-click **`↺ Create loop`**,
  auto-inserting a condition gate if the tail is a subagent). Loop members get a
  color-coded outer dashed outline and outer bypass rail with a clickable `↺ ×N`
  pill (`1–10` retries), resetting only loop members on retry, injecting failure
  feedback with healthy warm-session reuse, and circuit-breaking to the nearest
  Lead when exhausted.
- **Global & per-node `+ Refs`**: every node's top-right title bar supports up to
  16 reference paths, URLs, or rules automatically deduplicated and injected at
  run time.
- **Typed outputs, universal input**: output sockets pick the channel
  (`prompt` / `structured` / `session` / condition branch); every non-entry node
  exposes a single universal input (`in`) that accepts any wire and inherits the
  source colour. Arbitrary cycles are blocked immediately; drag a connected input
  away to detach its latest forward wire.
- Inactive nodes (unreachable from entry, blank-role solo chained Leads with no
  subagent upstream, or dangling dead-end subagents) are drawn dashed and skipped
  at run time.
- **Horizontal / vertical layout & slim narrow-sidebar UI**: toggle `⇄ Horiz` /
  `⇅ Vert` (remembered globally for new sessions, saved with custom presets and
  exported JSON, and undoable; top-in / bottom-out curves + condition `Out R / Out L`);
  toolbar provides compact `↶` / `↷` Undo/Redo buttons; right-click any node,
  edge, or blank canvas for context actions (insert on wire, create loop,
  duplicate/delete, layout, undo/redo) without conflicting with right-drag wire
  cutting (`>= 6px`). Bottom-right floating `⊡ | 100%` pill handles fit and
  scrub zoom, and simultaneous pan + wheel zoom stays anchored without drift.
- **Multi-select & customizable shortcuts**: marquee drag or `Shift`/`Ctrl`+click
  to multi-select; `Shift+A` adds at cursor, `Shift+D` duplicates selected nodes
  together with internal wires, `Delete` removes selected, `Ctrl+Z` /
  `Ctrl+Shift+Z` (`Ctrl+Y`) undo/redo (including node drags and layout flips),
  and `Esc` closes popups. Customize bindings under `⋯ → ⌨ Shortcuts`.
- **Live preset sync**: custom presets sync automatically across already-open
  sessions (with a manual `↻` refresh button and `H`/`V` direction tags).
- Click any subagent node's status pill (e.g. `Done ↗`) to jump straight to its
  live subagent chat pane.

## Editing from chat

| Tool | Effect |
|---|---|
| `canvas_inspect` | reads the current session canvas (enabled state, task, nodes, links) |
| `canvas_generate` | replaces the canvas with a node/edge sketch |
| `canvas_patch` | edits in place: update nodes by id, add/remove nodes and links |

`canvas_generate` and `canvas_patch` publish `<workspace>/.dsh/canvas/<session>.json`,
which the panel polls every 1.5s. A patch document is applied in merge mode so
node positions survive.

## Running

Subagent nodes run in an event-driven concurrency pool (default 4, configurable
1–8 via `⋯` or `maxParallel`) via `canvas_workflow`, which supports `task`
(override the entry task for template reuse), `reset: true` (discard a paused
run), `cancel: true` (cleanly stop an active or paused `need-lead` run),
`retryFailed: true` / `fromNodes` (reuse succeeded nodes and re-run only
failed/target segments plus downstream), and `clearMemory: true` (forget saved
`keepSession` memories). While enabled, a per-session runtime context notifies
the agent automatically. While running or paused at an intermediate Lead node,
a unified **`⏹ Stop`** button stays visible beside `● ON` (muted when idle, lighting up red alongside a compact `⏹` on the Entry Lead card while running or paused at an intermediate Lead) to interrupt all running subagents, cancel the root turn, and clear any
Lead pause via `/canvas-stop`. Intermediate Lead nodes pause with
`status: "need-lead"` and report `decisions` / `branchSkipped` / `failed` /
`emptyOutputs` plus `session` handovers and merged `refs`; a terminal Lead
completes directly with `status: "done"` and `finalLead`.

## Memory

`node id → child session id` is persisted on disk, keyed per session. A node
with memory on resumes that child (including cold resume after a Host restart);
if the Host refuses, the record is dropped and the node starts fresh.

## Limits

- Saved presets live in browser storage and do not auto-sync between the Desktop
  app and `dsh web`, nor across machines (use `⋯ → ⇧ Copy JSON` and `⇩ Import`
  to share or migrate them; 5 starter templates including conditional branching &
  retry loop are built in under `☰ Presets`).
- Lead steps have no child session; they show **Runs in chat** (or **Ready** once upstream finishes).
- Concurrency defaults to 4 (configurable 1–8 under `⋯`); controlled loops allow up to 1–10 retries per loop (20 global safety cap).

For architecture diagrams and runtime internals, see [MECHANISM.md](MECHANISM.md) ([中文](MECHANISM.zh.md)).
