---
name: workflow-canvas
description: Workflow canvas (画布 / 工作流 / 编排): inspect, draw, edit or run a node graph of DSH subagents — add or re-role nodes, wire typed links, run in parallel waves, handle Lead steps, presets and memory. Load before using canvas_inspect, canvas_generate, canvas_patch or canvas_workflow.
---

# Workflow canvas

A canvas is a DAG of agents the user can see and edit.

## Node kinds

- **Entry Lead** (`id: "lead"`, blue top bar) — created automatically by `canvas_generate` to hold the overall `task`. **Do not author a separate entry Lead node** — wire first-wave nodes directly from `from: "lead"`. The entry Lead **never** triggers `need-lead` (it does not pause before Wave 1).
- **Downstream Lead** (`kind: "lead"`, blue top bar) — performed by the conversation itself, never spawned. Any added non-entry Lead node holds a `role` and pauses the run (`status: "need-lead"`) so you can decide, review, or integrate before continuing. Direct `Lead → Lead` stage chains are supported (zero subagents spawned) as long as each chained Lead has a non-empty `role` describing its main-conversation stage.
- **Subagent** (`kind: "agent"`, green top bar) — spawned as a child agent with its own model, reasoning effort, capability scope, fallback model and memory switch. Wire every subagent's output into a downstream node or final Lead so nothing becomes a dead end.
- **Condition** (`kind: "condition"`, amber top bar) — lightweight read-only (`minimal`) branch judge that evaluates upstream outputs (including failure/incomplete flags) against `role`. Defaults to binary `if/else` (`branch: "true"` / `"false"`, returning `{ pass, reason }`); set `branches: ["通过", "小修", "重做"]` (2+ entries) for multi-way `switch/case` routing (`{ branches: [...], reason }`), with optional `multiMatch: true` to run all matching branches in parallel (and returning `[]` skips all downstream branches when none match). Unchosen branches are pruned automatically without spawning (even when a side `session-ref` wire connects an upstream ancestor into a pruned branch), and branches can converge back into a shared downstream node or terminal Lead.
- **References** (`refs: string[]`) — attach up to 16 reference file paths, URLs, or shared rules to Entry Lead (global `refs`, injected into every subagent) or any individual node (`node.refs`), cleanly replacing boilerplate read-only loader nodes.

## Which tool to call

| The user asks for | Call |
|---|---|
| inspecting or editing a manually drawn / preset canvas | `canvas_inspect` first to read node ids, models and links |
| a visual workflow, pipeline, or graph of agents | `canvas_generate` (replaces the canvas) |
| a change to the existing canvas | `canvas_patch` (edits in place, keeps the layout) |
| running the canvas | `canvas_workflow` (supports `leadResult`, `task` override, `reset: true`) |

Prefer `canvas_patch` for edits: it merges by node id, so renamed, re-roled or re-modelled nodes keep their position and untouched nodes stay as they are. Call `canvas_inspect` first if you do not already know the current node ids. Regenerating throws the layout away.

## Node fields

`id` (stable handle, never reuse it for a different node), `kind` (`lead`, `agent`, or `condition`), `label` (display name), `role` (what this step must do, or for `condition` nodes the routing rule), `refs` (optional up to 16 reference paths/URLs/rules; also accepted at top level for Entry Lead), `branches` (optional for `condition` nodes: 2–16 branch names for `switch/case`), `provider` / `model`, `reasoning` (an effort id declared by that model), `preset` (`standard` or `minimal`), `keepSession`, `fallbackModel` / `fallbackProvider`.

Fill `role` for every node. A node with an empty role still runs, but it invents its own task and may wander.

Capability (`preset`) is a two-state switch:

| value | means | useful for |
|---|---|---|
| `standard` | all tools — filesystem read/write/edit, shells, jobs, schedule, skills, subagents, workflow, web, present, office | steps that actually do work |
| `minimal` | read-only thinking — file read/write/edit disabled, no subagents, no workflow, no web; only image reading, persistent shells and compaction | steps that should only reason: review, classify, estimate, summarise |

## Links

| type | colour | carries |
|---|---|---|
| `prompt` | grey | the upstream result as plain text |
| `structured` | blue | a JSON object; the upstream node is asked for structured output automatically, so do not set that by hand |
| `session-ref` | purple | the upstream child session; the downstream step runs inside it |

Output sockets determine link type; every non-entry node has a single universal left input that accepts any incoming channel (`prompt`, `structured`, `session-ref`, or condition branches). Nodes the entry Lead cannot reach are skipped at run time and drawn dashed.

## Running

1. The canvas must be enabled (the pill over the canvas); `canvas_workflow` refuses while it is disabled. While enabled, the host automatically injects a per-session runtime context reminder on each turn.
2. You may pass `task` to override the entry Lead's task (handy when reusing a preset), `reset: true` to discard a paused run and start from scratch, `retryFailed: true` to reuse succeeded nodes and re-run only failed/empty/unfinished nodes plus their downstream, `fromNodes: [...]` to re-run from specific node ids/labels, `clearMemory: true` to forget saved `keepSession` child sessions, and `maxParallel` (1–8) to adjust concurrency.
3. Chained Lead nodes with **both** zero subagent upstream **and** an empty `role` — as well as dangling dead-end subagents (zero outgoing edges while an active downstream Lead exists) — are rendered dashed on the canvas and skipped at run time. Chained `Lead → Lead` stages with a non-empty `role` (or Lead + Subagent → Lead) are valid and active.
4. Subagent capability (`preset: standard | minimal`) narrows the toolset within the main chat's permission ceiling; it cannot elevate past the parent session's sandbox/approval mode.
3. Subagent nodes run in a dynamic concurrency pool of up to four: as soon as any node finishes, newly unblocked downstream subagents start immediately without waiting for slower siblings.
4. Intermediate downstream Lead nodes pause the run (`status: "need-lead"`). Complete that Lead step yourself, then call `canvas_workflow` again with `leadResult` to resume downstream nodes — do not spawn an agent for it.
5. A **terminal** Lead node (zero remaining downstream nodes) finishes directly with `status: "done"` and `finalLead`: complete the review/summary and reply directly to the user — no extra `canvas_workflow` callback is needed.
6. When a `session-ref` link points into that Lead node the result lists `sessions: [{ label, childId }]`; you may message those agents directly to follow up.
7. Only assign image/visual inspection roles to models that declare image input support.

## Failures & verification iron rule

A failing node (unknown model, provider error, a stop reason other than completed) does not abort the run. Its result carries the reason, a node with `fallbackModel` is retried once on that model, and unrecovered failures are listed in `failed: [{ id, label, reason }]` while downstream nodes are warned not to treat the error as valid output. Failed nodes show red in the canvas.

If a subagent finishes with no prose and no structured JSON (`[completed]` / `[no-output]`), it is flagged in `emptyOutputs: [{ id, label }]`. **Never claim a workflow or step succeeded while `failed`, `emptyOutputs`, or `【未完全交付】` is present** — always verify the declared files on disk or follow up with that subagent first.

## Designing a good workflow (checklist)

1. **Pre-flight before `canvas_workflow`**:
   - Never author a duplicate entry Lead — wire first-wave nodes from `from: "lead"`.
   - Always check `warnings` returned by `canvas_generate` / `canvas_patch` / `canvas_inspect` and fix dead-end subagents (missing out-links) or unreachable nodes before running.
   - Give parallel subagents **strictly disjoint file/directory ownership** in their `role` so two agents never overwrite the same file.
2. **When to add an intermediate Lead gate**:
   - **Add an intermediate Lead** when scope/architecture is not yet locked down (need human/Lead sign-off before coding), or when downstream steps heavily depend on foundation artifacts (e.g. verify scaffold/assets actually exist and pass checks before building levels on top).
   - **End-only Lead is fine** when all shared contracts (file paths, signals, APIs, groups) are already frozen upfront in the entry `task` and you want uninterrupted parallel execution into a final integration/review Lead.
3. **When to use `session-ref` (purple links)**:
   - **Subagent → Subagent**: when an implementer should continue a codebase scanner's warm session instead of re-reading the repo from scratch.
   - **Subagent → final Lead**: wire key implementation nodes into the final review/integration Lead with `session-ref` so if review finds bugs, you can message the original author's warm session to fix them in place.

## Memory

`keepSession: true` reuses that node's child session — across runs, and after a restart through a persisted id (cold resume). If the Host refuses the resume the record is dropped and the node starts fresh.

## Style

Keep labels short and distinct; ids must be unique even when labels repeat. Describe each step by its outcome and exact file ownership, not by internal tool names.
