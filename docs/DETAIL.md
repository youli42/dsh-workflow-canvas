# Workflow canvas

A node-graph canvas for orchestrating DSH subagents, docked in the right
sidebar. Draw a DAG (or load a starter template), enable it, and ask the agent
to run it — subagent nodes are spawned for real, Lead nodes pause the run and
are performed by the conversation itself.

## Canvas

- **Subagent node** (green top bar): spawns a child agent with its own
  `provider` / `model` / `reasoning effort` / capability scope (`standard` or
  `minimal`, bounded by the main chat permission mode). Optional **Memory** reuses
  the node's child session; optional **Fallback** retries once on another model.
- **Lead node** (blue top bar): performed by the conversation, never spawned. The
  entry node carries the overall task; intermediate Lead nodes pause for your
  decision, and a terminal Lead finishes in one shot without an extra callback.
- **Condition node** (amber top bar): lightweight read-only (`minimal`) branch
  judge supporting inline-editable binary `if/else` (`Yes` / `No`), multi-way
  `switch/case` (`+ Case`), and `Single` / `Multi` match modes (including clean
  zero-match full skip when no branch applies). Unchosen paths are pruned
  automatically without spawning, and branches can converge back into a shared
  downstream node or terminal Lead.
- **Typed outputs, universal input**: right-side output sockets pick the channel
  (`prompt` / `structured` / `session` / condition branch); every non-entry node
  exposes a single universal left input (`in`) that accepts any wire and inherits
  the source colour. Cycles are blocked immediately; drag a connected input away
  to detach its latest wire.
- Inactive nodes (unreachable from entry, solo chained Leads with no subagent
  upstream, or dangling dead-end subagents) are drawn dashed and skipped at run time.
- Wheel zooms around the cursor; middle-drag (or `Space` + drag) pans; `⊡ Fit`
  fits all nodes into the visible viewport; the percentage button resets to 100%
  on the Lead.
- Marquee selection: drag on empty canvas to select multiple nodes; dragging any
  selected node moves the whole selection.
- Right-drag across links cuts them on release; the swept path and links about to
  be cut highlight in red (toggle under `⋯`).
- Shortcuts: `Shift+A` opens the Add Node menu at the cursor,
  `Ctrl+D` duplicates selected nodes, `Delete` removes selected nodes, `Ctrl+Z`
  undoes, and `Esc` closes popups. `⋯` also provides `⊞ Auto layout`,
  `⇧ Copy JSON`, and `Visual effects` (`Minimal` / `Standard` / `Vivid`).
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
run), `retryFailed: true` / `fromNodes` (reuse succeeded nodes and re-run only
failed/target segments plus downstream), and `clearMemory: true` (forget saved
`keepSession` memories). While enabled, a per-session runtime context notifies
the agent automatically. Intermediate Lead nodes pause with `status: "need-lead"`
and report `decisions` / `branchSkipped` / `failed` / `emptyOutputs` plus
`session` handovers; a terminal Lead completes directly with `status: "done"`
and `finalLead`.

## Memory

`node id → child session id` is persisted on disk, keyed per session. A node
with memory on resumes that child (including cold resume after a Host restart);
if the Host refuses, the record is dropped and the node starts fresh.

## Limits

- Saved presets live in browser storage and do not auto-sync between the Desktop
  app and `dsh web`, nor across machines (use `⋯ → ⇧ Copy JSON` and `⇩ Import`
  to share or migrate them; starter templates are built in under `☰ Presets`).
- Lead steps have no tracked state; they show **Runs in chat** (or **Ready** once all upstream subagents finish).
- Up to 4 nodes run at a time.

For architecture diagrams and runtime internals, see [MECHANISM.md](MECHANISM.md) ([中文](MECHANISM.zh.md)).
