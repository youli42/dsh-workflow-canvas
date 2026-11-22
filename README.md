# DSH Workflow Canvas

[![npm version](https://img.shields.io/npm/v/dsh-workflow-canvas)](https://www.npmjs.com/package/dsh-workflow-canvas)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.2-2f81f7)](https://github.com/Wasabi2575/dsh-workflow-canvas)
[![License: MIT](https://img.shields.io/badge/License-MIT-3fb950.svg)](LICENSE)

English | [中文](README.zh.md) | [Mechanism & Architecture](docs/MECHANISM.md)

Turn multi-agent orchestration in DSH into a visual node graph: each card is an AI role, each wire defines who feeds whom, and pressing **● ON** lets you run the whole pipeline straight from chat.

- **Real parallelism**: Independent nodes run concurrently (default 4, configurable 1–8 under `⋯`), and newly unblocked downstream nodes start the instant their inputs finish.
- **Conditional branching**: Drop a **Condition** node anywhere to route downstream along `✓ Yes` or `✕ No` based on upstream results — the unchosen branch is skipped automatically without spawning.
- **Human-in-the-loop**: Drop a **Lead** card anywhere in the flow to pause automatically for your decision before continuing.
- **Zero black box**: Click any subagent card to open its live chat transcript and inspect its exact output.
- **Don't want to draw by hand?** Describe the workflow in one sentence in chat — the agent sketches the graph for you and can patch it in place anytime.

![Workflow canvas overview](docs/images/canvas-demo.png)

## Installation

Requires DeepSeek Harness **0.2.2** or newer (`engines.dsh: ">=0.2.2-rc.1 <0.3.0-0"`).

- **From the plugin market** — open **Plugins → Discover**, search *"workflow canvas"*, and install ([catalog PR #17180](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17180)).
- **From npm** — install `dsh-workflow-canvas` from the **Plugins** panel or via `plugin_manager` / `dsh` CLI (`install_bundle`).
- **From source** — clone this repo and install it via **Plugins → Add plugin** pointing at the local folder.

Once enabled, open the **`Workflow`** tab in the right sidebar.

---

## Usage

### 1. Node types

There are four node types on the canvas (Entry Lead, Subagent, Lead, Condition):

| Node | Description |
|---|---|
| <img src="docs/images/node-entry-en.png" width="220" alt="Entry Lead node" /> | **Entry Lead (start node, always present)**<br>• The starting point of the graph — **right-side output sockets only**.<br>• Write the overall goal in **Task**, or leave it blank and send your prompt directly in chat once the canvas is **● ON**.<br>• Every node that should run must be reachable from here. |
| <img src="docs/images/node-subagent-en.png" width="220" alt="Subagent node" /> | **Subagent (green top bar — runs in an isolated child session)**<br>• **Model / Reasoning**: Configure model and reasoning effort per node.<br>• **Scope**: `standard` (all tools) or `minimal` (read-only thinking — disables file edits and web), bounded by the main chat's permission mode.<br>• **Fallback**: Automatically retries once on another model if the primary one fails.<br>• **Memory**: Flip **on** to enable the session dropdown beside it (**Latest** or pin any past run `#1 / #2`; muted when off).<br>• **Role**: Edit inline or click `⤢` to open a larger editor. |
| <img src="docs/images/node-lead-en.png" width="220" alt="Lead node" /> | **Lead (blue top bar — runs directly in the main conversation)**<br>• **Never spawned** — handled by your main chat itself.<br>• **Mid-flow** (e.g. `Lead Pick`): pauses with `⏸ Ready` once upstream finishes so you can decide before downstream starts.<br>• **End-of-flow** (e.g. `Lead Review`): delivers the final summary in one shot without an extra round-trip.<br>• Requires at least one subagent upstream (solo Lead-to-Lead nodes render dashed and are skipped). |
| <img src="docs/images/node-condition-en.png" width="220" alt="Condition node" /> | **Condition (amber top bar — lightweight read-only judge for `if/else`, `switch/case` & parallel multi-match)**<br>• Runs as a dedicated lightweight read-only subagent with **Model / Reasoning / Fallback** controls; both the overall rule and every individual branch have a `⤢` button to open a larger editor.<br>• Starts with inline editable **`Yes` / `No`** branches; click **`+ Case`** to add more named branches freely (e.g. `Pass / Minor Fix / Rewrite / Other`).<br>• Toggle **`Single`** (pick at most 1 best match) vs **`Multi`** (run all matching branches in parallel); if none match or the condition node itself fails, it never guesses a branch — it skips intermediate branches and hands off to the nearest downstream Lead (or halts cleanly for `retryFailed: true`). |

Load a built-in template from **`☰ Presets`**, or press **`Shift+A`** anywhere on the canvas to add a node (`⋯` also provides `⊞ Auto layout` and `✕ Clear canvas`):

![Add a node with Shift+A and connect it](docs/images/add-node-shift-a.gif)

---

### 2. Links and data flow

**Drag from a right-side output socket on an upstream node to the universal left input (`in`) on a downstream node** to pass results forward — every non-entry node has a single universal input that automatically inherits the wire type and colour from its source output.

Output socket colour indicates the channel type:
| Colour | Type | Description |
|---|---|---|
| Grey | `prompt` | Passes plain-text output downstream |
| Blue | `structured` | Passes a JSON object; the upstream node is automatically asked for structured output |
| Purple | `session` | Continues inside the upstream child session without reloading context |

- **Disconnect**: Hold **right-click and sweep across any wire** to cut it (or drag a connected left socket away).
- **Dashed nodes (inactive)**: Unreachable nodes, solo chained Lead nodes with no subagent upstream, and dangling dead-end subagents render **dashed** and are skipped at run time.

![Right-drag to cut a link and re-wire](docs/images/connect-and-cut.gif)

---

### 3. Per-node settings

Every subagent node can be configured independently:
- **Model & Reasoning**: Assign different models and effort levels per step.
- **Scope**: `standard` (all tools) or `minimal` (read-only thinking). *Bounded by the main chat's permission mode.*
- **Fallback**: Retries once on another model when the primary model fails.
- **Memory**: Reuses a past child session across runs and restarts, with a dropdown to pick **Latest** or a specific run.

![Configure model, reasoning, scope, fallback and memory per node](docs/images/node-config.gif)

---

### 4. Enable and run

Press **`● ON`** at the top-left of the canvas, then send your task in chat (while enabled, a per-session runtime context notifies the agent automatically):

- If the entry Lead's task is blank, your chat message is passed as `task`.
- At an intermediate **Lead** node, the canvas shows **`⏸ Ready`** and hands control to chat; once you reply, downstream nodes resume automatically through the final Lead review.
- Re-running in the same chat supports `reset: true`; if any node has saved **Memory**, the agent confirms whether to keep memory or clear it (`clearMemory: true`).

![Auto-run enabled canvas, pause at Lead decision, and finish](docs/images/lead-pause-resume.gif)

---

### 5. Inspect live subagent runs

Active nodes glow blue with animated flow wires and turn green when done. **Click the status badge (`Running ↗` / `Done ↗`) at the bottom-left of any subagent node** to open its conversation pane:

![Parallel execution and clicking straight into a subagent chat](docs/images/parallel-and-inspect.gif)

---

## Let the agent draw or edit the canvas from chat

- **Sketch from one sentence** (`canvas_generate`): *"Build a parallel research workflow on the canvas: two subagents investigate competitors and feasibility, pause for me to decide, then write the plan."*
- **Patch in place** (`canvas_inspect` + `canvas_patch`): *"Inspect the current canvas, turn Memory on for feasibility, and add a read-only cost-estimate node wired into plan synthesis."* (Preserves your layout.)

## Shortcuts & controls

| Control / Shortcut | Action |
|---|---|
| `Shift+A` | Add a node at the cursor (`1` = Subagent, `2` = Lead, `3` = Condition) |
| Middle-drag / `Space` + left-drag | Pan the canvas |
| Wheel / `⊡ Fit` / `100%` pill | Zoom around cursor / fit all nodes / click to reset 100%, drag left-right to scrub zoom |
| Marquee drag + `Ctrl+D` / `Delete` | Multi-select move, duplicate (with settings), or batch delete |
| Right-drag across wires | Cut links (toggle under `⋯`) |
| `Ctrl+Z` / `Esc` | Undo structural edit / close popups |
| `⋯` menu | Import / Copy JSON, Auto layout, Clear canvas, Visual effects (Minimal / Standard / Vivid) |

## Presets, sharing & limits

- **Presets & cross-session reuse**: Click `☰ Presets` to save the current canvas at the top of the menu (immediately available in any new chat), or load one of the 4 starter templates and **New blank canvas**. Custom presets live in browser storage — use `⋯ → ⇧ Copy JSON` and `⇩ Import` to share across devices.
- **Partial resume & concurrency**: If a mid-flow node fails, call `retryFailed: true` or `fromNodes` to reuse succeeded outputs and re-run only the failed segment and its downstream; adjust max concurrency (1 / 2 / 4 / 6 / 8, default 4) under `⋯`.
- **How this differs from other canvas plugins**: Built for **multi-subagent orchestration + conditional routing + conversation Lead gates**; for `ctx.workflows` low-level tool pipelines, see [`@piedpiper911/dsh-workflow-canvas`](https://github.com/PiedPiper911/dsh-workflow-canvas).
- **Limits**: Per-node `Scope` only narrows tools within the main chat's permission/sandbox ceiling.

## Development & internals

- See [**Mechanism & Architecture**](docs/MECHANISM.md) ([中文](docs/MECHANISM.zh.md)) for the Client ↔ Host bridge, event-driven concurrency pool, link semantics, and cold resume.
- Edit `client.js` / `index.js` and reload (Host changes require restart). Run `npm test` for the test suite. Compact plugin page: [docs/DETAIL.md](docs/DETAIL.md).

## License

MIT — see [LICENSE](LICENSE).
