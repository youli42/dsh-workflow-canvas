/**
 * Host half of the workflow-canvas bundle.
 *
 * The browser canvas owns editing. This half executes the canvas plan:
 *   - `canvas-sync` publishes the plan for its Session (client → Host);
 *   - the `canvas_workflow` tool runs the DAG in parallel waves. Subagent nodes
 *     are spawned through `ctx.subagents` (per-node model, reasoning effort and
 *     preset all work); a Lead node pauses the run and hands control back to the
 *     conversation, which resumes it with `leadResult`.
 *
 * Extra behavior, all optional per node:
 *   - `keepSession` re-uses the node's previous child session (memory);
 *   - `fallbackModel` retries a failed node once on another model;
 *   - plans survive a Host restart through a JSON file in the profile.
 *
 * Everything is defensive: a missing service disables one piece instead of
 * failing the plugin load.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Latest canvas payload per Session id. */
const canvasBySession = new Map();
/** In-flight run progress per Session id. */
const runBySession = new Map();
/** Snapshot of the last completed/halted run per Session id (enables partial retry). */
const lastRunBySession = new Map();
/**
 * Two separate maps by design:
 *   - `childByNode`: persisted memory slot written ONLY when `keepSession` is ON,
 *     so temporary `keepSession=false` runs never overwrite saved memory.
 *   - `liveChild`: latest child id in this process (updated even when Memory is OFF)
 *     so downstream `session-ref` purple links can always continue the upstream run.
 */
const childByNode = new Map();
const liveChild = new Map();

function storePath() {
  const home = process.env.DSH_PROFILE_DIR;
  if (!home) return undefined;
  return join(home, '.workflow-canvas-state.json');
}

function loadStore() {
  const path = storePath();
  if (!path) return;
  try {
    const raw = readFileSync(path, 'utf8');
    const doc = JSON.parse(raw);
    if (doc && doc.canvas && typeof doc.canvas === 'object') {
      for (const [sid, payload] of Object.entries(doc.canvas)) canvasBySession.set(sid, payload);
    }
    if (doc && doc.children && typeof doc.children === 'object') {
      for (const [node, child] of Object.entries(doc.children)) childByNode.set(node, child);
    }
  } catch (_e) {
    /* no store yet, or unreadable: start clean */
  }
}

function saveStore() {
  const path = storePath();
  if (!path) return;
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify({
      canvas: Object.fromEntries(canvasBySession),
      children: Object.fromEntries(childByNode),
    }), 'utf8');
    renameSync(tmp, path);
  } catch (_e) {
    /* persistence is best-effort */
  }
}

/** The entry Lead is a task container, never a runnable node. */
function withoutEntry(nodes) {
  return (nodes || []).filter((n) => n.id !== 'lead');
}

function parsePayload(rawInput) {
  const text = String(rawInput || '').trim();
  if (!text) return { enabled: false };
  try {
    return JSON.parse(decodeURIComponent(text));
  } catch (_e) {
    return { enabled: false, error: '画布数据解析失败' };
  }
}

/** Kahn topological order over every plan node. */
function orderNodes(plan) {
  const nodes = plan.nodes || [];
  const edges = plan.edges || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (e.from === 'lead') continue;
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    indeg.set(e.to, indeg.get(e.to) + 1);
    adj.get(e.from).push(e.to);
  }
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const out = [];
  while (queue.length) {
    const id = queue.shift();
    out.push(byId.get(id));
    for (const next of adj.get(id)) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  return out.length === nodes.length ? out : null;
}

function upstreamOf(plan, node) {
  const byId = new Map((plan.nodes || []).map((n) => [n.id, n]));
  return (plan.edges || [])
    .filter((e) => e.to === node.id)
    .map((e) => ({ edge: e, from: byId.get(e.from) }))
    .filter((x) => x.from);
}

function downstreamLabels(plan, node) {
  const byId = new Map((plan.nodes || []).map((n) => [n.id, n]));
  return (plan.edges || [])
    .filter((e) => e.from === node.id)
    .map((e) => (byId.get(e.to) || {}).label)
    .filter(Boolean);
}

function normalizeKind(rawKind) {
  if (rawKind === 'lead') return 'lead';
  if (rawKind === 'condition') return 'condition';
  return 'agent';
}

function normalizeBranch(rawBranch) {
  if (rawBranch === true) return 'true';
  if (rawBranch === false) return 'false';
  if (typeof rawBranch !== 'string') return '';
  return rawBranch.trim();
}

const DEFAULT_BINARY_BRANCHES = [
  { id: 'true', label: '是' },
  { id: 'false', label: '否' },
];

/**
 * Normalize a condition node's branch list (2–5 entries).
 * Accepts either string arrays (e.g. `['通过', '小修', '重做']`) or `{ id, label }` objects.
 * Returns `null` when the node uses the default binary `true`/`false` pair.
 */
function normalizeBranches(rawBranches) {
  if (!Array.isArray(rawBranches) || rawBranches.length < 2) return null;
  const out = [];
  const used = new Set();
  for (let i = 0; i < Math.min(16, rawBranches.length); i += 1) {
    const item = rawBranches[i];
    let id = '';
    let label = '';
    if (typeof item === 'string') {
      label = item.trim();
      id = label;
    } else if (item && typeof item === 'object') {
      id = typeof item.id === 'string' ? item.id.trim() : '';
      label = typeof item.label === 'string' ? item.label.trim() : '';
      if (!id) id = label;
      if (!label) label = id;
    }
    if (!id) id = 'case_' + (i + 1);
    if (!label) label = '分支 ' + (i + 1);
    let uniq = id;
    let suffix = 2;
    while (used.has(uniq)) { uniq = id + '_' + suffix; suffix += 1; }
    used.add(uniq);
    out.push({ id: uniq, label });
  }
  return out.length >= 2 ? out : null;
}

function conditionBranches(node) {
  const custom = normalizeBranches(node && node.branches);
  const multiMatch = Boolean(node && node.multiMatch);
  if (custom) return { branches: custom, isDefaultBinary: false, multiMatch };
  return { branches: DEFAULT_BINARY_BRANCHES, isDefaultBinary: !multiMatch, multiMatch };
}

function edgeKey(e) {
  return String(e.from) + '->' + String(e.to) + '|' + String(e.type || 'prompt') + '|' + String(e.branch || '');
}

/**
 * Parse a condition node's structured or text output into
 * `{ branches, branchLabels, branch, branchLabel, pass, reason }`.
 * Supports:
 *   - default binary `{ pass: boolean }`
 *   - single-match `switch/case` (`{ branches: [id] }` or `{ branch: id }`, or `[]` when none match)
 *   - multi-match parallel fan-out (`multiMatch: true`, `{ branches: [id1, id2, ...] }` or `[]`)
 */
function parseConditionDecision(result, fallbackText, nodeOrBranches) {
  const { branches, isDefaultBinary, multiMatch } = Array.isArray(nodeOrBranches)
    ? { branches: normalizeBranches(nodeOrBranches) || DEFAULT_BINARY_BRANCHES, isDefaultBinary: !normalizeBranches(nodeOrBranches), multiMatch: false }
    : conditionBranches(nodeOrBranches);

  const resolveByToken = (token) => {
    const t = String(token || '').trim();
    if (!t) return null;
    const exactId = branches.find((b) => b.id === t);
    if (exactId) return exactId;
    const exactLabel = branches.find((b) => b.label === t);
    if (exactLabel) return exactLabel;
    const lower = t.toLowerCase();
    const ci = branches.find((b) => b.id.toLowerCase() === lower || b.label.toLowerCase() === lower);
    return ci || null;
  };

  const makeDecision = (pickedList, reason) => {
    const seen = new Set();
    const uniq = [];
    for (const item of pickedList) {
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      uniq.push(item);
    }
    const finalList = multiMatch ? uniq : uniq.slice(0, 1);
    const first = finalList[0] || null;
    return {
      branches: finalList.map((b) => b.id),
      branchLabels: finalList.map((b) => b.label),
      branch: first ? first.id : '',
      branchLabel: first ? first.label : '',
      pass: isDefaultBinary ? Boolean(first && first.id === 'true') : finalList.length > 0,
      reason: String(reason || ''),
    };
  };

  const tryObj = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj.branches)) {
      const hits = obj.branches.map(resolveByToken).filter(Boolean);
      return makeDecision(hits, obj.reason);
    }
    if (typeof obj.branch === 'string') {
      const trimmed = obj.branch.trim();
      if (!trimmed || /^(none|null|无|都不满足|未命中)$/i.test(trimmed)) {
        return makeDecision([], obj.reason);
      }
      const hit = resolveByToken(trimmed);
      if (hit) return makeDecision([hit], obj.reason);
    }
    if (typeof obj.pass === 'boolean') {
      const picked = obj.pass ? branches[0] : branches[branches.length - 1];
      return makeDecision([picked], obj.reason);
    }
    return null;
  };

  const fromStructured = tryObj(result && result.structured);
  if (fromStructured) return fromStructured;

  const raw = String(fallbackText || '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const fromJson = tryObj(JSON.parse(raw.slice(start, end + 1)));
      if (fromJson) return fromJson;
    } catch (_e) { /* fall through */ }
  }

  if (isDefaultBinary) {
    if (/^(true|yes|pass|通过|是)\b/i.test(raw)) return makeDecision([branches[0]], raw.slice(0, 200));
    return makeDecision([branches[1]], raw.slice(0, 200) || '未能解析布尔判断，默认走「否」分支');
  }

  // Multi-way text fallback: collect matching branch ids/labels; return empty [] if none match.
  const lowerRaw = raw.toLowerCase();
  const matched = [];
  for (const b of branches) {
    if (lowerRaw.includes(b.id.toLowerCase()) || lowerRaw.includes(b.label.toLowerCase())) {
      matched.push(b);
      if (!multiMatch) break;
    }
  }
  return makeDecision(matched, raw.slice(0, 200) || (matched.length ? '' : '未命中任何分支，已跳过后续分支'));
}

function briefFor(plan, node, results, failedMap, prunedSet) {
  const ups = upstreamOf(plan, node).filter((u) => !(prunedSet && prunedSet.has(u.from.id)));
  const downs = downstreamLabels(plan, node);
  const head = [];
  if (node.kind === 'condition') {
    const outEdges = (plan.edges || []).filter((e) => e.from === node.id);
    const byId = new Map((plan.nodes || []).map((n) => [n.id, n]));
    const { branches, isDefaultBinary, multiMatch } = conditionBranches(node);
    head.push('【工作流条件判断节点】你负责判断当前工作流接下来走哪条分支（「' + node.label + '」）。');
    head.push('【总任务】' + plan.task);
    if (isDefaultBinary) {
      const yesTargets = outEdges.filter((e) => (normalizeBranch(e.branch) || 'true') === 'true').map((e) => (byId.get(e.to) || {}).label || e.to);
      const noTargets = outEdges.filter((e) => normalizeBranch(e.branch) === 'false').map((e) => (byId.get(e.to) || {}).label || e.to);
      head.push('【判断条件】' + (node.role || '判断上游步骤是否执行成功并达到预期；成功返回 true，失败或未达标返回 false。'));
      head.push('【分支去向】pass=true（是）→ ' + (yesTargets.join('、') || '（无）') + '；pass=false（否）→ ' + (noTargets.join('、') || '（无）'));
      head.push('【要求】严格依据上游实际输出（含成功/失败状态与【未完全交付】标记）做出客观判断，只返回 JSON 对象 {"pass": true/false, "reason": "一句话理由"}。');
    } else {
      const branchLines = branches.map((b, idx) => {
        const targets = outEdges
          .filter((e) => {
            const eb = normalizeBranch(e.branch);
            return eb ? eb === b.id : idx === 0;
          })
          .map((e) => (byId.get(e.to) || {}).label || e.to);
        const tag = b.label === b.id ? '"' + b.id + '"' : '"' + b.id + '"（' + b.label + '）';
        return '- ' + tag + ' → ' + (targets.join('、') || '（无下游）');
      });
      head.push('【判断规则】' + (node.role || (multiMatch
        ? '根据上游结果选出所有满足条件的分支（可多选并行）；若均不满足返回空数组。'
        : '根据上游结果选出最匹配的一条分支；若均不满足返回空数组（如有「其他/兜底」分支则选它）。')));
      head.push('【匹配模式】' + (multiMatch
        ? '多选并行（可返回 0 条、1 条或多条分支 id）'
        : '单选分流（最多返回 1 条最匹配的分支 id；均不满足返回空数组 []）'));
      head.push('【可选分支】\n' + branchLines.join('\n'));
      head.push('【要求】严格依据上游实际输出（含成功/失败状态与【未完全交付】标记）做出客观判断，只返回 JSON 对象 {"branches": ["<分支id>"], "reason": "一句话理由"}；若没有任何分支满足，返回 {"branches": [], "reason": "..."}。');
    }
  } else {
    head.push('【工作流节点】你在一个多步工作流里负责「' + node.label + '」这一步（子代理）。');
    if (ups.length === 0) head.push('【总任务】' + plan.task);
    head.push('【职责】' + (node.role || node.label));
    if (ups.length) head.push('【上游】' + ups.map((u) => u.from.label).join('、') + ' 已交付结果给你（见下文）。');
    head.push('【下游】' + (downs.length ? downs.join('、') + ' 会使用你的输出。' : '你是终点，结果会直接交付给用户。'));
    head.push('【要求】只完成你这一步；最终回复只输出简洁、可直接被下游或 Lead 消费的交付报告（结论、改动清单、关键接口/路径），不要包含思考独白、过程叙述或对其他并行节点的评价。若因环境或权限受限未能生成预期产物，必须在开头显式标注「【未完全交付】」并列出缺失项，不得把仅写脚本汇报为已完成。');
  }
  let text = head.join('\n') + '\n';
  for (const u of ups) {
    const value = results[u.from.id];
    const type = u.edge.type || 'prompt';
    const body = typeof value === 'string' ? value : '（没有结果）';
    const failInfo = failedMap && failedMap[u.from.id];
    const warn = failInfo
      ? '【警告：该上游节点执行失败（' + (failInfo.reason || 'unknown') + '），请勿将其报错当作正常结论，必要时说明受阻情况】\n'
      : '';
    if (type === 'structured') {
      text += '\n## 来自【' + u.from.label + '】的数据（JSON，可直接解析）\n' + warn + '```json\n'
        + body + '\n```\n';
    } else if (type === 'session-ref') {
      text += '\n## 来自【' + u.from.label + '】的会话引用（当前按文本传递）\n' + warn
        + body + '\n';
    } else {
      text += '\n## 来自【' + u.from.label + '】\n' + warn + body + '\n';
    }
  }
  return text;
}

function textOf(result) {
  // A structured node's canonical value is its parsed object, not the prose.
  if (result && result.structured !== undefined) {
    try {
      return JSON.stringify(result.structured);
    } catch (_e) {
      /* fall through to prose */
    }
  }
  const blocks = (result && result.output) || [];
  const text = blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('');
  return text || '[' + ((result && result.stopReason) || 'no-output') + ']';
}

function failed(result) {
  const reason = result && result.stopReason;
  return reason !== undefined && reason !== 'completed';
}

function isEmptyOutput(result) {
  if (result && result.structured !== undefined) return false;
  const blocks = (result && result.output) || [];
  const text = blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('');
  return text.trim().length === 0;
}

async function spawnOnce(scope, plan, node, results, parent, signal, route, forcedChild, sid, failedMap, prunedSet) {
  const childKey = (id) => String(sid || '') + '::' + id;
  const isCondition = node.kind === 'condition';
  const spec = {
    provider: 'spawn',
    label: node.label + '#' + node.id,
    prompt: [{ type: 'text', text: briefFor(plan, node, results, failedMap, prunedSet) }],
    parent,
    signal,
    delivery: 'caller',
  };
  const agentOptions = {};
  const provider = (route && route.provider) || node.provider;
  const model = (route && route.model) || node.model;
  if (provider) agentOptions.provider = provider;
  if (model) agentOptions.model = model;
  if (node.reasoning) agentOptions.reasoningEffort = node.reasoning;
  if (Object.keys(agentOptions).length) spec.agentOptions = agentOptions;
  if (isCondition) {
    const { branches, isDefaultBinary, multiMatch } = conditionBranches(node);
    spec.agentPreset = 'minimal';
    spec.outputSchema = isDefaultBinary
      ? {
          type: 'object',
          properties: {
            pass: { type: 'boolean', description: 'true to follow the Yes/Pass branch, false to follow the No/Fail branch.' },
            reason: { type: 'string', description: 'Concise one-sentence explanation for this routing decision.' },
          },
          required: ['pass', 'reason'],
          additionalProperties: false,
        }
      : {
          type: 'object',
          properties: {
            branches: {
              type: 'array',
              items: { type: 'string', enum: branches.map((b) => b.id) },
              description: multiMatch
                ? 'All matching branch ids to execute in parallel (empty array if none match).'
                : 'At most one best-matching branch id (empty array if none match).',
            },
            reason: { type: 'string', description: 'Concise one-sentence explanation for this routing decision.' },
          },
          required: ['branches', 'reason'],
          additionalProperties: false,
        };
  } else {
    if (node.preset) spec.agentPreset = node.preset;
    const wantsStructured = Boolean(node.structured)
      || (plan.edges || []).some((e) => e.from === node.id && e.type === 'structured');
    if (wantsStructured) {
      spec.outputSchema = {
        type: 'object',
        additionalProperties: true,
        description: 'Return the result as a JSON object so downstream steps can consume it.',
      };
    }
  }

  const run = async (childId) => {
    const withChild = childId ? { ...spec, childId } : spec;
    let activation;
    try {
      activation = await scope.subagents.startActivation(withChild);
    } catch (error) {
      const message = String((error && error.message) || error);
      return { ok: false, text: '启动失败：' + message, reason: 'activation-failed' };
    }
    try {
      if (activation && activation.childId) {
        liveChild.set(childKey(node.id), activation.childId);
        // Only overwrite the persisted memory slot when Memory is ON, so a
        // temporary keepSession=false experiment never destroys saved memory.
        if (node.keepSession) childByNode.set(childKey(node.id), activation.childId);
      }
      let result;
      try {
        result = await activation.result;
      } catch (error) {
        const message = String((error && error.message) || error);
        return { ok: false, text: '运行失败：' + message, reason: 'run-failed' };
      }
      const outText = textOf(result);
      const outcome = {
        ok: !failed(result),
        text: outText,
        reason: result && result.stopReason,
        empty: isEmptyOutput(result),
      };
      if (isCondition) {
        outcome.decision = parseConditionDecision(result, outText, node);
      }
      return outcome;
    } finally {
      try { await activation.dispose(); } catch (_e) { /* ignore */ }
    }
  };

  // A `session` edge means "continue the upstream node's conversation": run this
  // step inside that child session instead of starting a fresh one.
  if (forcedChild) {
    const continued = await run(forcedChild);
    if (continued.ok) {
      liveChild.set(childKey(node.id), forcedChild);
      return continued;
    }
    if (continued.reason !== 'activation-failed') {
      return continued;
    }
    /* activation refused (e.g. cold session gone): fall through to a fresh session */
  }

  // Memory: prefer an explicitly pinned `memoryChildId` from the node dropdown,
  // then the saved memory slot (`childByNode`), then this process's live child.
  // A cold resume that the Host refuses falls through to a fresh session.
  if (node.keepSession) {
    const pinned = typeof node.memoryChildId === 'string' ? node.memoryChildId.trim() : '';
    const saved = childByNode.get(childKey(node.id));
    const inProcess = liveChild.get(childKey(node.id));
    const previous = pinned || saved || inProcess;
    if (previous) {
      const resumed = await run(previous);
      if (resumed.ok) return resumed;
      if (resumed.reason === 'activation-failed') {
        if (previous === inProcess) liveChild.delete(childKey(node.id));
        if (previous === saved) childByNode.delete(childKey(node.id));
      } else {
        return resumed;
      }
    }
  }
  const started = await run(undefined);
  if (node.keepSession && started.ok) {
    const current = childByNode.get(childKey(node.id));
    if (current) liveChild.set(childKey(node.id), current);
  }
  return started;
}

async function spawnNode(scope, plan, node, results, parent, signal, sid, failedMap, prunedSet) {
  const continueFrom = (plan.edges || [])
    .filter((e) => e.to === node.id && e.type === 'session-ref' && !(prunedSet && prunedSet.has(e.from)))
    .map((e) => liveChild.get(String(sid || '') + '::' + e.from)
      || childByNode.get(String(sid || '') + '::' + e.from))
    .find((id) => typeof id === 'string');

  if (continueFrom) {
    const continued = await spawnOnce(scope, plan, node, results, parent, signal, undefined, continueFrom, sid, failedMap, prunedSet);
    if (continued.ok) {
      const out = { ok: true, empty: Boolean(continued.empty), text: continued.text + '\n（已在上游会话中继续）' };
      if (continued.decision) out.decision = continued.decision;
      return out;
    }
  }

  const first = await spawnOnce(scope, plan, node, results, parent, signal, undefined, undefined, sid, failedMap, prunedSet);
  if (first.ok) {
    const out = { ok: true, empty: Boolean(first.empty), text: first.text };
    if (first.decision) out.decision = first.decision;
    return out;
  }
  if (!node.fallbackModel && !node.fallbackProvider) {
    const reason = first.reason || 'unknown';
    return { ok: false, empty: false, reason, text: first.text + '\n（失败原因：' + reason + '，未配置备用模型）' };
  }
  const retry = await spawnOnce(scope, plan, node, results, parent, signal, {
    provider: node.fallbackProvider,
    model: node.fallbackModel,
  }, undefined, sid, failedMap, prunedSet);
  if (retry.ok) {
    const out = { ok: true, empty: Boolean(retry.empty), text: retry.text + '\n（已用备用模型重试成功）' };
    if (retry.decision) out.decision = retry.decision;
    return out;
  }
  const reason = retry.reason || 'unknown';
  return { ok: false, empty: false, reason, text: retry.text + '\n（重试仍失败：' + reason + '）' };
}

/** Ids reachable from the entry Lead via O(V + E) BFS; every other node is skipped at run time. */
function reachableFrom(plan) {
  const adj = new Map();
  for (const e of (plan && plan.edges) || []) {
    if (!e || !e.from || !e.to) continue;
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  const set = new Set(['lead']);
  const queue = ['lead'];
  for (let i = 0; i < queue.length; i += 1) {
    const cur = queue[i];
    for (const next of adj.get(cur) || []) {
      if (!set.has(next)) { set.add(next); queue.push(next); }
    }
  }
  return set;
}

/**
 * Classify inactive nodes that are rendered dashed on the canvas and skipped at run time:
 *   - unreachable orphans
 *   - solo chained Leads (zero reachable subagent upstream)
 *   - dangling dead-end subagents (zero outgoing edges while an active non-ancestor downstream Lead exists)
 */
function inactiveNodeSets(nodes, edges) {
  const list = withoutEntry(nodes);
  const linkList = Array.isArray(edges) ? edges : [];
  const reachable = reachableFrom({ edges: linkList });
  const byId = new Map(list.map((n) => [n.id, n]));

  const soloLeads = new Set();
  for (const n of list) {
    if (n.kind !== 'lead' || !reachable.has(n.id)) continue;
    const hasAgentUp = linkList.some((e) => {
      if (!e || e.to !== n.id || !reachable.has(e.from) || e.from === 'lead') return false;
      const src = byId.get(e.from);
      return Boolean(src && src.kind !== 'lead');
    });
    if (!hasAgentUp) soloLeads.add(n.id);
  }

  const deadEnds = new Set();
  const activeLeads = list.filter((n) => n.kind === 'lead' && reachable.has(n.id) && !soloLeads.has(n.id));
  if (activeLeads.length) {
    const hasOut = new Set(linkList.map((e) => e.from));
    const parents = new Map();
    for (const e of linkList) {
      if (!parents.has(e.to)) parents.set(e.to, []);
      parents.get(e.to).push(e.from);
    }
    const ancestorsOf = (id) => {
      const seen = new Set();
      const stack = [id];
      while (stack.length) {
        const cur = stack.pop();
        for (const p of parents.get(cur) || []) {
          if (!seen.has(p)) { seen.add(p); stack.push(p); }
        }
      }
      return seen;
    };
    for (const n of list) {
      if (n.kind === 'lead' || !reachable.has(n.id) || hasOut.has(n.id)) continue;
      const anc = ancestorsOf(n.id);
      if (activeLeads.some((ln) => !anc.has(ln.id))) deadEnds.add(n.id);
    }
  }
  return { reachable, soloLeads, deadEnds };
}

/**
 * Detect structural warnings on a canvas plan (all three classes are rendered
 * dashed on the canvas and skipped at run time):
 *   1. Unreachable nodes.
 *   2. Solo chained Lead nodes with zero subagent upstream.
 *   3. Dangling dead-end subagent nodes with zero outgoing edges.
 */
function analyzeCanvasWarnings(nodes, edges) {
  const list = withoutEntry(nodes);
  const linkList = Array.isArray(edges) ? edges : [];
  const warnings = [];
  if (!list.length) return warnings;

  const { reachable, soloLeads, deadEnds } = inactiveNodeSets(list, linkList);
  const orphans = list.filter((n) => !reachable.has(n.id));
  if (orphans.length) {
    warnings.push('以下节点未从入口 Lead 连通，运行时会被跳过：'
      + orphans.map((n) => (n.label || n.id) + '(' + n.id + ')').join('、'));
  }
  const soloList = list.filter((n) => soloLeads.has(n.id));
  if (soloList.length) {
    warnings.push('以下 Lead 节点仅串联了其他 Lead、未连入子代理，运行时不生效：'
      + soloList.map((n) => (n.label || n.id) + '(' + n.id + ')').join('、'));
  }
  const deadList = list.filter((n) => deadEnds.has(n.id));
  if (deadList.length) {
    warnings.push('以下子代理节点没有出边，产出未连入下游或终审 Lead，运行时不生效：'
      + deadList.map((n) => (n.label || n.id) + '(' + n.id + ')').join('、'));
  }
  return warnings;
}

/**
 * Turn a model-authored sketch into a canvas document: assign ids, ensure one
 * connected entry Lead, and lay the graph out in columns by depth.
 */
function normalizeCanvas(args) {
  const rawNodes = Array.isArray(args && args.nodes) ? args.nodes : [];
  const rawEdges = Array.isArray(args && args.edges) ? args.edges : [];
  if (!rawNodes.length) return { error: '至少需要一个节点' };

  const nodes = [];
  const idByRef = new Map();
  const usedIds = new Set();
  let counter = 0;
  let hasExplicitLead = false;
  for (const raw of rawNodes) {
    if (!raw || typeof raw !== 'object') continue;
    counter += 1;
    const kind = normalizeKind(raw.kind);
    const wantsEntry = !hasExplicitLead && (raw.id === 'lead' || (raw.entry === true && kind === 'lead'));
    let id = wantsEntry
      ? 'lead'
      : (typeof raw.id === 'string' && raw.id && raw.id !== 'lead' ? raw.id : 'n' + counter);
    if (usedIds.has(id)) {
      let suffix = 2;
      while (usedIds.has(id + '_' + suffix)) suffix += 1;
      id = id + '_' + suffix;
    }
    usedIds.add(id);
    if (id === 'lead') hasExplicitLead = true;
    const defaultLabel = kind === 'lead'
      ? 'Lead 步骤 ' + counter
      : (kind === 'condition' ? '条件判断 ' + counter : 'Node ' + counter);
    const label = String(raw.label || defaultLabel);
    const nodeObj = {
      id,
      kind: id === 'lead' ? 'lead' : kind,
      label,
      role: String(raw.role || ''),
      task: String(raw.task || ''),
      provider: String(raw.provider || ''),
      model: String(raw.model || ''),
      reasoning: String(raw.reasoning || ''),
      preset: String(raw.preset || ''),
      structured: Boolean(raw.structured),
      keepSession: Boolean(raw.keepSession),
      fallbackModel: String(raw.fallbackModel || ''),
      fallbackProvider: String(raw.fallbackProvider || ''),
      x: 0,
      y: 0,
    };
    if (nodeObj.kind === 'condition') {
      const customBranches = normalizeBranches(raw.branches);
      if (customBranches) nodeObj.branches = customBranches;
      if (raw.multiMatch === true) nodeObj.multiMatch = true;
    }
    nodes.push(nodeObj);
    if (raw.ref && !idByRef.has(String(raw.ref))) idByRef.set(String(raw.ref), id);
    if (raw.id && !idByRef.has(String(raw.id))) idByRef.set(String(raw.id), id);
    idByRef.set(id, id);
  }
  if (!nodes.length) return { error: '节点都无效' };

  const ids = new Set(nodes.map((n) => n.id));
  const edges = [];
  for (const raw of rawEdges) {
    if (!raw || typeof raw !== 'object') continue;
    const from = idByRef.get(String(raw.from)) || String(raw.from);
    const to = idByRef.get(String(raw.to)) || String(raw.to);
    if ((from !== 'lead' && !ids.has(from)) || !ids.has(to) || from === to || to === 'lead') continue;
    const type = ['prompt', 'structured', 'session-ref'].includes(raw.type) ? raw.type : 'prompt';
    const branch = normalizeBranch(raw.branch);
    const edgeObj = { id: 'e' + edges.length, from, to, type };
    if (branch) edgeObj.branch = branch;
    edges.push(edgeObj);
  }

  let entry = nodes.find((n) => n.id === 'lead');
  if (!entry) {
    // If the caller hand-authored a root Lead node (no incoming edges, has outgoing edges)
    // and didn't wire from id='lead', promote it to entry Lead instead of duplicating it.
    const hasLeadEdge = edges.some((e) => e.from === 'lead');
    const inSet = new Set(edges.map((e) => e.to));
    const outSet = new Set(edges.map((e) => e.from));
    const rootLead = !hasLeadEdge
      ? nodes.find((n) => n.kind === 'lead' && !inSet.has(n.id) && outSet.has(n.id))
      : null;
    if (rootLead) {
      const oldId = rootLead.id;
      rootLead.id = 'lead';
      rootLead.task = rootLead.task || String(args.task || '') || rootLead.role;
      rootLead.role = '';
      for (const e of edges) {
        if (e.from === oldId) e.from = 'lead';
      }
      entry = rootLead;
    } else {
      entry = {
        id: 'lead', kind: 'lead', label: 'Lead（本对话）', role: '',
        task: String(args.task || ''), provider: '', model: '', reasoning: '',
        preset: '', structured: false, keepSession: false, fallbackModel: '', fallbackProvider: '',
        x: 0, y: 0,
      };
      nodes.unshift(entry);
    }
  } else if (!entry.task) {
    entry.task = String(args.task || '') || entry.role;
  }

  // If entry Lead still has no outgoing edges, auto-wire it to all root nodes so
  // a freshly generated canvas is never dead/unreachable on arrival.
  if (!edges.some((e) => e.from === 'lead')) {
    const hasIn = new Set(edges.map((e) => e.to));
    const roots = nodes.filter((n) => n.id !== 'lead' && !hasIn.has(n.id));
    for (const root of roots) {
      edges.push({ id: 'e' + edges.length, from: 'lead', to: root.id, type: 'prompt' });
    }
  }

  const structuredSources = new Set(edges.filter((e) => e.type === 'structured').map((e) => e.from));
  for (const node of nodes) {
    if (structuredSources.has(node.id)) node.structured = true;
  }

  // Layout: depth of the longest path from the entry, then stack per column.
  const depth = new Map(nodes.map((n) => [n.id, n.id === 'lead' ? 0 : 1]));
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const e of edges) {
      if (e.to === 'lead') continue;
      const next = Math.min(nodes.length, depth.get(e.from) + 1);
      if (next > depth.get(e.to)) { depth.set(e.to, next); changed = true; }
    }
    if (!changed) break;
  }
  const perColumn = new Map();
  for (const node of nodes) {
    const level = depth.get(node.id) || 0;
    const row = perColumn.get(level) || 0;
    perColumn.set(level, row + 1);
    node.x = 60 + level * 300;
    node.y = 80 + row * 260;
  }

  return {
    nodes,
    edges,
    task: String(entry.task || args.task || ''),
    warnings: analyzeCanvasWarnings(nodes, edges),
  };
}

/**
 * Apply an in-place patch to an existing plan: update/add/remove nodes and
 * edges without losing untouched nodes. Preserves `'lead'` as a valid edge
 * source so newly added branches can wire directly from the entry Lead.
 */
function applyPatch(plan, args) {
  const nodes = withoutEntry(plan.nodes).map((n) => ({ ...n }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ALLOWED = ['label', 'role', 'provider', 'model', 'reasoning', 'preset', 'keepSession', 'memoryChildId', 'structured', 'fallbackModel', 'fallbackProvider'];
  const touched = [];
  for (const patch of args && Array.isArray(args.nodes) ? args.nodes : []) {
    // 'lead' is the reserved entry node and is never edited here.
    if (!patch || typeof patch.id !== 'string' || patch.id === 'lead') continue;
    const existing = byId.get(patch.id);
    if (existing) {
      for (const key of ALLOWED) {
        if (patch[key] !== undefined) existing[key] = patch[key];
      }
      if (patch.kind !== undefined) existing.kind = normalizeKind(patch.kind);
      if (patch.branches !== undefined) {
        const nb = normalizeBranches(patch.branches);
        if (nb) existing.branches = nb;
        else delete existing.branches;
      }
      if (patch.multiMatch !== undefined) {
        if (patch.multiMatch) existing.multiMatch = true;
        else delete existing.multiMatch;
      }
      touched.push(patch.id);
    } else {
      const created = {
        id: patch.id,
        kind: normalizeKind(patch.kind),
        label: patch.label || patch.id,
        role: '', provider: '', model: '', reasoning: '', preset: 'standard',
        structured: false, keepSession: false, fallbackModel: '', fallbackProvider: '',
      };
      for (const key of ALLOWED) {
        if (patch[key] !== undefined) created[key] = patch[key];
      }
      created.preset = created.preset === 'minimal' ? 'minimal' : 'standard';
      if (created.kind === 'condition' && patch.branches !== undefined) {
        const nb = normalizeBranches(patch.branches);
        if (nb) created.branches = nb;
      }
      if (created.kind === 'condition' && patch.multiMatch === true) {
        created.multiMatch = true;
      }
      nodes.push(created);
      byId.set(created.id, created);
      touched.push(created.id);
    }
  }
  const removed = new Set(Array.isArray(args && args.removeNodes) ? args.removeNodes : []);
  removed.delete('lead');
  const keptNodes = nodes.filter((n) => !removed.has(n.id));
  const keptIds = new Set(keptNodes.map((n) => n.id));
  const rawRemoveEdges = Array.isArray(args && args.removeEdges) ? args.removeEdges : [];
  const matchesRemovedEdge = (edge) => rawRemoveEdges.some((r) => {
    if (!r || String(r.from) !== edge.from || String(r.to) !== edge.to) return false;
    if (r.type && r.type !== edge.type) return false;
    const rb = normalizeBranch(r.branch);
    if (rb && rb !== normalizeBranch(edge.branch)) return false;
    return true;
  });
  let edges = (Array.isArray(plan.edges) ? plan.edges : [])
    .filter((e) => !matchesRemovedEdge(e) && !removed.has(e.from) && !removed.has(e.to))
    .map((e) => ({ ...e }));
  for (const edge of Array.isArray(args && args.edges) ? args.edges : []) {
    if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string') continue;
    if (edge.from === edge.to || edge.to === 'lead') continue;
    const validFrom = edge.from === 'lead' || keptIds.has(edge.from);
    const validTo = keptIds.has(edge.to);
    if (!validFrom || !validTo) continue;
    const type = ['prompt', 'structured', 'session-ref'].includes(edge.type) ? edge.type : 'prompt';
    const branch = normalizeBranch(edge.branch);
    if (edges.some((e) => e.from === edge.from && e.to === edge.to && e.type === type && normalizeBranch(e.branch) === branch)) continue;
    const nextEdge = { from: edge.from, to: edge.to, type };
    if (branch) nextEdge.branch = branch;
    edges.push(nextEdge);
  }
  const structuredSources = new Set(edges.filter((e) => e.type === 'structured').map((e) => e.from));
  for (const node of keptNodes) {
    node.structured = structuredSources.has(node.id);
  }
  const taskPatched = typeof (args && args.task) === 'string';
  const nextTask = taskPatched ? args.task : String(plan.task || '');
  return {
    plan: { ...plan, task: nextTask, nodes: keptNodes, edges },
    touched,
    taskPatched,
    removed: Array.from(removed),
    removeEdges: rawRemoveEdges
      .filter((r) => r && typeof r.from === 'string' && typeof r.to === 'string')
      .map((r) => {
        const item = { from: r.from, to: r.to };
        if (r.type) item.type = r.type;
        const rb = normalizeBranch(r.branch);
        if (rb) item.branch = rb;
        return item;
      }),
  };
}

/**
 * Drop a generated canvas where the browser can pick it up. `workspaceFiles`
 * resolves a session's root from its header cwd, so the client reads the same
 * relative path back through the Remote.
 */
function publishCanvas(scope, sessionId, canvas) {
  try {
    const live = scope && scope.sessions && scope.sessions.get(sessionId);
    const root = live && live.header && live.header.cwd;
    if (!root) return false;
    const dir = join(root, '.dsh', 'canvas');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, sessionId + '.json'), JSON.stringify({ canvas, at: Date.now() }), 'utf8');
    return true;
  } catch (_e) {
    return false;
  }
}

async function runPlan(scope, args, exec) {
  const agent = exec && exec.agent;
  const sid = agent && agent.id !== undefined ? String(agent.id) : '';
  const payload = sid ? canvasBySession.get(sid) : undefined;
  if (!payload) return { error: '当前会话还没有画布数据。请在右侧 Workflow 画布点「启用」。' };
  if (!payload.enabled) return { error: '画布当前是「已禁用」状态。请在画布上点「启用」后再运行。' };
  if (payload.error) return { error: String(payload.error) };
  return executePlan(scope, payload.plan, args, exec);
}

function inspectPlan(sid) {
  const payload = sid ? canvasBySession.get(sid) : undefined;
  if (!payload) {
    return {
      hasCanvas: false,
      enabled: false,
      task: '',
      nodes: [],
      edges: [],
      warnings: [],
      paused: false,
    };
  }
  const plan = payload.plan || {};
  const nodes = withoutEntry(plan.nodes).map((n) => {
    const item = {
      id: String(n.id || ''),
      kind: normalizeKind(n.kind),
      label: String(n.label || n.id || ''),
      role: String(n.role || ''),
      provider: String(n.provider || ''),
      model: String(n.model || ''),
      reasoning: String(n.reasoning || ''),
      preset: n.preset === 'minimal' ? 'minimal' : 'standard',
      keepSession: Boolean(n.keepSession),
      structured: Boolean(n.structured),
      fallbackModel: String(n.fallbackModel || ''),
      fallbackProvider: String(n.fallbackProvider || ''),
    };
    if (item.kind === 'condition') {
      const nb = normalizeBranches(n.branches);
      if (nb) item.branches = nb;
      if (n.multiMatch) item.multiMatch = true;
    }
    return item;
  });
  const edges = Array.isArray(plan.edges) ? plan.edges.map((e) => {
    const out = {
      from: String(e.from || ''),
      to: String(e.to || ''),
      type: String(e.type || 'prompt'),
    };
    const branch = normalizeBranch(e.branch);
    if (branch) out.branch = branch;
    return out;
  }) : [];
  const out = {
    hasCanvas: true,
    enabled: Boolean(payload.enabled),
    task: String(plan.task || ''),
    nodes,
    edges,
    warnings: analyzeCanvasWarnings(nodes, edges),
    paused: Boolean(sid && runBySession.get(sid) && runBySession.get(sid).waitingLead),
  };
  // Never attach `error: undefined`: DSH's lossless JSON validator rejects keys with undefined values.
  if (payload.error) out.error = String(payload.error);
  return out;
}

/** Extract the active session id from a DSH `AssembleContext`. */
function sessionIdFromContext(assembleCtx) {
  if (!assembleCtx || typeof assembleCtx !== 'object') return '';
  if (assembleCtx.agent && assembleCtx.agent.id !== undefined) return String(assembleCtx.agent.id);
  if (assembleCtx.sessionId !== undefined) return String(assembleCtx.sessionId);
  return '';
}

/**
 * Per-turn runtime prompt context injected ONLY for the session whose canvas is
 * currently enabled. DSH invokes `systemPrompt.context` for both main chats AND
 * spawned subagents, so strict `sid` matching (returning '' on miss) is required
 * to prevent leaking canvas instructions into subagents and causing recursion.
 */
function buildActiveCanvasContext(sid) {
  if (!sid) return '';
  const payload = canvasBySession.get(String(sid));
  if (!payload || !payload.enabled || payload.error) return '';
  const plan = payload.plan;
  const nodes = withoutEntry(plan && plan.nodes);
  if (!nodes.length) return '';

  const runState = runBySession.get(String(sid));
  if (runState && runState.waitingLead) {
    const wl = runState.waitingLead;
    return [
      '[Workflow Canvas Active — Paused at Lead Step]',
      '当前会话的工作流画布正暂停在中间 Lead 节点「' + wl.label + '」（分工：' + (wl.role || wl.label) + '）。',
      '- 若用户的当前消息是在拍板、确认、补充决策或要求继续：请整理决策结论并直接调用 `canvas_workflow({ leadResult: "..." })` 恢复下游节点运行。',
      '- 若用户要求放弃当前进度从头重跑：调用 `canvas_workflow({ reset: true })`。',
      '- 若用户要求修改画布结构/分工：先 `canvas_inspect` 再用 `canvas_patch`。',
    ].join('\n');
  }

  const preview = nodes
    .slice(0, 8)
    .map((n) => (n.kind === 'lead' ? '〔Lead〕' : (n.kind === 'condition' ? '〔条件〕' : '')) + (n.label || n.id))
    .join(' → ') + (nodes.length > 8 ? ' …' : '');
  const hasTask = Boolean(String((plan && plan.task) || '').trim());
  const prefix = String(sid) + '::';
  const hasMemory = nodes.some((n) => n.keepSession && (liveChild.has(prefix + n.id) || childByNode.has(prefix + n.id)));
  const lines = [
    '[Workflow Canvas Active]',
    '当前会话的右侧工作流画布处于「● 已启用」状态（共 ' + nodes.length + ' 个执行节点：' + preview + '；入口总任务：' + (hasTask ? '已填写' : '未填写') + '）。',
    '- 若用户发出任务请求、布置工作或说「开始 / 执行 / 跑一次」：请直接调用 `canvas_workflow` 按画布编排执行（'
      + (hasTask ? '可直接沿用入口总任务；若用户给出了新任务则通过 task 参数传入' : '请将用户的任务内容作为 task 参数传入')
      + '），不要绕过画布直接自己完成。',
    '- 若用户在讨论或要求修改画布结构、模型、分工或连线：请先 `canvas_inspect` 再用 `canvas_patch` 就地修改，不要直接运行。',
    '- 仅当用户明确只是闲聊、问无关问题或要求先停用画布时，才无需调用 `canvas_workflow`。',
  ];
  if (hasMemory) {
    lines.push('- 本会话已有开启「记忆」节点的历史子代理会话：若用户说「再跑一次 / 换个任务重跑」，请先简短询问用户是保留上次记忆继续（reset: true）还是清空记忆全新开跑（reset: true, clearMemory: true）。');
  }
  const stdCount = nodes.filter((n) => n.kind !== 'lead' && n.preset !== 'minimal').length;
  if (stdCount >= 2) {
    lines.push('- 本画布包含 ' + stdCount + ' 个可写/命令型（standard）子代理，受主对话权限上限约束；若任务涉及改代码、写文件或跑终端命令且当前主对话权限偏严格，请先简短提醒用户放开主对话权限再调 `canvas_workflow`，避免中途报错白耗额度。');
  }
  const prevRun = lastRunBySession.get(String(sid));
  if (prevRun) {
    const badNames = [
      ...Object.values(prevRun.failed || {}).map((f) => f.label || f.id),
      ...Object.values(prevRun.emptyOutputs || {}).map((e) => e.label || e.id),
    ].filter((v, i, arr) => v && arr.indexOf(v) === i);
    if (prevRun.halted || badNames.length) {
      lines.push('- 上次运行存在失败/熔断节点（' + (badNames.join('、') || '部分未完成')
        + '）：若用户要求只重跑失败部分或继续未完成段，请调用 `canvas_workflow({ retryFailed: true })` 局部续跑（自动复用已成功节点缓存，零重复消耗）；也可传 `fromNodes: ["节点id"]` 指定从某个节点开始重跑。');
    }
  }
  return lines.join('\n');
}

/** Detect permission / sandbox denial outcomes so we can circuit-break before burning downstream tokens. */
const PERMISSION_ERR_RE = /permission denied|access is denied|sandbox-local|windows-acl|win32error|eacces|eperm|approval required|not permitted|拒绝访问|权限不足|无权执行|沙箱拒绝/i;
function isPermissionFailure(outcome) {
  if (!outcome) return false;
  const text = String(outcome.text || '');
  if (!outcome.ok && PERMISSION_ERR_RE.test(text)) return true;
  if (text.includes('【未完全交付】') && PERMISSION_ERR_RE.test(text)) return true;
  return false;
}

/** Takes a plan directly so tests can feed any plan shape (sync, generate, patch). */
async function executePlan(scope, plan, args, exec) {
  const opts = args || {};
  const agent = exec && exec.agent;
  const sid = agent && agent.id !== undefined ? String(agent.id) : '';
  if (!plan || !Array.isArray(plan.nodes) || !plan.nodes.length) {
    return { error: '画布没有可执行的节点。' };
  }

  const overrideTask = typeof opts.task === 'string' ? opts.task.trim() : '';
  const effectiveTask = overrideTask || String(plan.task || '').trim();
  if (!effectiveTask) {
    return { error: '请先在入口 Lead 节点填写「本次任务」，或在调用 canvas_workflow 时传入 task。' };
  }

  // Backstop: no matter how a plan arrived (sync, generate, patch, a stale store),
  // the entry Lead is never executed.
  plan = { ...plan, task: effectiveTask, nodes: withoutEntry(plan.nodes) };

  const order = orderNodes(plan);
  if (!order) return { error: '存在环，无法执行有向无环图。' };

  // Defense in depth: unreachable orphans, solo chained Leads, and dangling
  // dead-end subagents are skipped instead of wasting tokens or stalling.
  const { reachable, soloLeads, deadEnds } = inactiveNodeSets(plan.nodes, plan.edges);
  const isInactive = (n) => !reachable.has(n.id) || soloLeads.has(n.id) || deadEnds.has(n.id);
  const runnable = order.filter((n) => !isInactive(n));
  const skipped = order.filter((n) => isInactive(n)).map((n) => n.label || n.id);
  if (!runnable.length) return { error: '没有从入口 Lead 连通的有效节点，无法执行。' };

  if (opts.clearMemory === true && sid) {
    const prefix = String(sid) + '::';
    for (const key of Array.from(childByNode.keys())) {
      if (key.startsWith(prefix)) childByNode.delete(key);
    }
    for (const key of Array.from(liveChild.keys())) {
      if (key.startsWith(prefix)) liveChild.delete(key);
    }
    saveStore();
  }
  if (opts.reset === true && sid) {
    runBySession.delete(sid);
    lastRunBySession.delete(sid);
  }

  const byId = new Map(runnable.map((n) => [n.id, n]));
  const labelOf = new Map(order.map((n) => [n.id, n.label || n.id]));
  const sig = JSON.stringify(plan);
  let state = runBySession.get(sid);
  const wantRetryFailed = opts.retryFailed === true;
  const rawFromNodes = Array.isArray(opts.fromNodes) ? opts.fromNodes.filter((x) => typeof x === 'string' && x.trim()) : [];
  const wantPartial = wantRetryFailed || rawFromNodes.length > 0;
  let reused = [];

  if (wantPartial && sid) {
    const base = state || lastRunBySession.get(sid);
    if (base) {
      state = {
        sig,
        done: new Set(Array.from(base.done || []).filter((id) => byId.has(id))),
        results: { ...(base.results || {}) },
        labels: { ...(base.labels || {}) },
        failed: { ...(base.failed || {}) },
        emptyOutputs: { ...(base.emptyOutputs || {}) },
        blockedEdges: new Set(Array.from(base.blockedEdges || [])),
        pruned: new Set(Array.from(base.pruned || []).filter((id) => byId.has(id))),
        decisions: { ...(base.decisions || {}) },
        fallbackLinks: Array.isArray(base.fallbackLinks) ? base.fallbackLinks.map((fl) => ({ ...fl })) : [],
        waitingLead: null,
      };
      // Build forward adjacency to invalidate seed nodes and all their downstream dependents.
      const fwd = new Map();
      for (const e of plan.edges || []) {
        if (!e || !e.from || !e.to) continue;
        if (!fwd.has(e.from)) fwd.set(e.from, []);
        fwd.get(e.from).push(e.to);
      }
      const seeds = new Set();
      if (wantRetryFailed) {
        for (const id of Object.keys(state.failed)) seeds.add(id);
        for (const id of Object.keys(state.emptyOutputs)) seeds.add(id);
      }
      for (const ref of rawFromNodes) {
        const trimmed = ref.trim();
        if (byId.has(trimmed)) seeds.add(trimmed);
        else {
          const match = runnable.find((n) => n.label === trimmed);
          if (match) seeds.add(match.id);
        }
      }
      const invalid = new Set(seeds);
      const q = Array.from(seeds);
      for (let i = 0; i < q.length; i += 1) {
        for (const next of fwd.get(q[i]) || []) {
          if (!invalid.has(next)) { invalid.add(next); q.push(next); }
        }
      }
      for (const id of invalid) {
        state.done.delete(id);
        state.pruned.delete(id);
        delete state.results[id];
        delete state.labels[id];
        delete state.failed[id];
        delete state.emptyOutputs[id];
        delete state.decisions[id];
      }
      for (const e of plan.edges || []) {
        if (e && invalid.has(e.from)) state.blockedEdges.delete(edgeKey(e));
      }
      state.fallbackLinks = state.fallbackLinks.filter((fl) => !invalid.has(fl.from) && !invalid.has(fl.to));
      reused = Array.from(state.done).filter((id) => !state.pruned.has(id)).map((id) => labelOf.get(id) || id);
      runBySession.set(sid, state);
    }
  }

  if (!state || state.sig !== sig) {
    state = {
      sig,
      done: new Set(),
      results: {},
      labels: {},
      failed: {},
      emptyOutputs: {},
      blockedEdges: new Set(),
      pruned: new Set(),
      decisions: {},
      fallbackLinks: [],
      waitingLead: null,
    };
    runBySession.set(sid, state);
  }
  if (!state.emptyOutputs) state.emptyOutputs = {};
  if (!state.blockedEdges) state.blockedEdges = new Set();
  if (!state.pruned) state.pruned = new Set();
  if (!state.decisions) state.decisions = {};
  if (!state.fallbackLinks) state.fallbackLinks = [];

  const snapshotLastRun = (haltedFlag) => {
    if (!sid) return;
    lastRunBySession.set(sid, {
      sig: state.sig,
      done: new Set(state.done),
      results: { ...state.results },
      labels: { ...state.labels },
      failed: { ...state.failed },
      emptyOutputs: { ...state.emptyOutputs },
      blockedEdges: new Set(state.blockedEdges),
      pruned: new Set(state.pruned),
      decisions: { ...state.decisions },
      fallbackLinks: state.fallbackLinks.map((fl) => ({ ...fl })),
      halted: Boolean(haltedFlag),
    });
  };
  const depsOf = (node) => {
    const out = new Set();
    for (const e of plan.edges || []) {
      if (e.to === node.id
        && e.from !== 'lead'
        && !state.blockedEdges.has(edgeKey(e))
        && !state.pruned.has(e.from)
        && byId.has(e.from)) {
        out.add(e.from);
      }
    }
    for (const fl of state.fallbackLinks || []) {
      if (fl.to === node.id && byId.has(fl.from)) out.add(fl.from);
    }
    return Array.from(out);
  };
  const nearestDownstreamLead = (startId) => {
    const fwd = new Map();
    for (const e of plan.edges || []) {
      if (!e || !e.from || !e.to) continue;
      if (!fwd.has(e.from)) fwd.set(e.from, []);
      fwd.get(e.from).push(e.to);
    }
    const seen = new Set([startId]);
    const queue = [startId];
    for (let i = 0; i < queue.length; i += 1) {
      const cur = queue[i];
      for (const next of fwd.get(cur) || []) {
        if (seen.has(next)) continue;
        seen.add(next);
        const candidate = byId.get(next);
        if (candidate && candidate.kind === 'lead' && !state.done.has(candidate.id)) {
          return candidate;
        }
        queue.push(next);
      }
    }
    return null;
  };
  const branchSkippedList = () => Array.from(state.pruned).map((id) => labelOf.get(id) || id);
  const ancestorsOf = (targetId) => {
    const parents = new Map();
    for (const e of plan.edges || []) {
      if (!e || !e.from || !e.to) continue;
      if (!parents.has(e.to)) parents.set(e.to, []);
      parents.get(e.to).push(e.from);
    }
    const seen = new Set();
    const stack = [targetId];
    while (stack.length) {
      const cur = stack.pop();
      for (const p of parents.get(cur) || []) {
        if (!seen.has(p)) { seen.add(p); stack.push(p); }
      }
    }
    return seen;
  };
  const recomputeBranchPrune = () => {
    // Re-evaluate reachability from entry Lead over non-blocked edges so diamond
    // convergence nodes stay active, while side-channel edges from ancestors of a
    // condition node (e.g. A --session-ref--> N) cannot bypass a blocked branch gate.
    const condAncestors = new Map();
    const blockedSources = new Map();
    for (const e of plan.edges || []) {
      if (!e || !e.from || !e.to) continue;
      if (!state.blockedEdges.has(edgeKey(e))) continue;
      if (!blockedSources.has(e.to)) blockedSources.set(e.to, new Set());
      blockedSources.get(e.to).add(e.from);
      if (!condAncestors.has(e.from)) condAncestors.set(e.from, ancestorsOf(e.from));
    }

    const gatedBy = new Map();
    const addGates = (nodeId, condIds) => {
      if (!gatedBy.has(nodeId)) gatedBy.set(nodeId, new Set());
      const set = gatedBy.get(nodeId);
      for (const c of condIds) set.add(c);
    };
    for (const [toId, cSet] of blockedSources.entries()) addGates(toId, cSet);

    const isBypassEdge = (e) => {
      const directGates = blockedSources.get(e.to);
      if (directGates) {
        for (const cId of directGates) {
          if ((condAncestors.get(cId) || new Set()).has(e.from)) return true;
        }
      }
      if (e.type === 'session-ref') {
        const inherited = gatedBy.get(e.to);
        if (inherited) {
          for (const cId of inherited) {
            if ((condAncestors.get(cId) || new Set()).has(e.from)) return true;
          }
        }
      }
      return false;
    };

    for (let pass = 0; pass <= runnable.length; pass += 1) {
      const adj = new Map();
      for (const e of plan.edges || []) {
        if (!e || !e.from || !e.to) continue;
        if (state.blockedEdges.has(edgeKey(e))) continue;
        if (state.pruned.has(e.from)) continue;
        if (isBypassEdge(e)) continue;
        if (!adj.has(e.from)) adj.set(e.from, []);
        adj.get(e.from).push(e.to);
      }
      for (const fl of state.fallbackLinks || []) {
        if (!fl || !fl.from || !fl.to || state.pruned.has(fl.from)) continue;
        if (!adj.has(fl.from)) adj.set(fl.from, []);
        adj.get(fl.from).push(fl.to);
      }
      const active = new Set(['lead']);
      const queue = ['lead'];
      for (let i = 0; i < queue.length; i += 1) {
        const cur = queue[i];
        for (const next of adj.get(cur) || []) {
          if (!active.has(next)) { active.add(next); queue.push(next); }
        }
      }
      let addedAny = false;
      for (const n of runnable) {
        if (!state.done.has(n.id) && !inFlight.has(n.id) && !active.has(n.id)) {
          state.pruned.add(n.id);
          state.done.add(n.id);
          addedAny = true;
          const gates = gatedBy.get(n.id);
          if (gates && gates.size) {
            for (const e of plan.edges || []) {
              if (e && e.from === n.id && e.to) addGates(e.to, gates);
            }
          }
        }
      }
      if (!addedAny) break;
    }
  };

  let leadResult = typeof opts.leadResult === 'string' ? opts.leadResult : undefined;
  const rawMaxParallel = opts.maxParallel !== undefined ? opts.maxParallel : plan.maxParallel;
  const MAX_PARALLEL = Number.isFinite(Number(rawMaxParallel))
    ? Math.max(1, Math.min(8, Math.floor(Number(rawMaxParallel))))
    : 4;
  // Event-driven concurrency pool: as soon as any node finishes, newly unblocked
  // downstream agents start immediately instead of waiting for slower siblings.
  const inFlight = new Map();

  const isAborted = () => Boolean(exec && exec.signal && exec.signal.aborted);
  const permBlocked = [];
  let activationFailCount = 0;
  let haltedReason = '';

  const launchReadyAgents = () => {
    if (isAborted() || haltedReason || inFlight.size >= MAX_PARALLEL) return;
    const candidates = runnable.filter((n) => n.kind !== 'lead'
      && !state.done.has(n.id)
      && !inFlight.has(n.id)
      && depsOf(n).every((id) => state.done.has(id)));
    for (const node of candidates) {
      if (isAborted() || haltedReason || inFlight.size >= MAX_PARALLEL) break;
      const promise = spawnNode(scope, plan, node, state.results, agent, exec.signal, sid, state.failed, state.pruned)
        .then(
          (outcome) => ({ node, outcome }),
          (err) => ({ node, outcome: { ok: false, reason: 'run-failed', text: '运行失败：' + String((err && err.message) || err) } }),
        );
      inFlight.set(node.id, promise);
    }
  };

  for (;;) {
    if (isAborted()) {
      if (sid) runBySession.delete(sid);
      return { error: '工作流执行已取消。' };
    }
    // On circuit-break halt, stop launching new downstream waves immediately,
    // but let already in-flight siblings settle so no orphan promises or partial
    // results are dropped before returning the halted report.
    if (haltedReason && inFlight.size === 0) {
      snapshotLastRun(true);
      if (sid) runBySession.delete(sid);
      saveStore();
      return {
        status: 'halted',
        error: haltedReason + '（放开权限后可调用 canvas_workflow({ retryFailed: true }) 只重跑失败与未完成节点）',
        results: state.results,
        labels: state.labels,
        failed: Object.values(state.failed),
        emptyOutputs: Object.values(state.emptyOutputs),
        decisions: Object.values(state.decisions),
        branchSkipped: branchSkippedList(),
        reused,
        skipped,
      };
    }
    const remaining = runnable.filter((n) => !state.done.has(n.id));
    if (!remaining.length) {
      snapshotLastRun(false);
      runBySession.delete(sid);
      saveStore();
      return {
        status: 'done',
        results: state.results,
        labels: state.labels,
        failed: Object.values(state.failed),
        emptyOutputs: Object.values(state.emptyOutputs),
        decisions: Object.values(state.decisions),
        branchSkipped: branchSkippedList(),
        reused,
        skipped,
      };
    }

    launchReadyAgents();

    if (inFlight.size > 0) {
      const { node, outcome } = await Promise.race(inFlight.values());
      inFlight.delete(node.id);
      if (isAborted()) {
        if (sid) runBySession.delete(sid);
        return { error: '工作流执行已取消。' };
      }
      state.labels[node.id] = node.label;
      if (node.kind === 'condition') {
        const { branches, isDefaultBinary } = conditionBranches(node);
        if (!outcome.ok) {
          const failReason = outcome.reason || 'unknown';
          state.failed[node.id] = { id: node.id, label: node.label, reason: failReason };
          state.decisions[node.id] = {
            id: node.id,
            label: node.label,
            branches: [],
            branchLabels: [],
            branch: '',
            branchLabel: '',
            pass: false,
            failed: true,
            reason: outcome.text || ('运行失败：' + failReason),
          };
          state.results[node.id] = '【条件节点自身执行失败：' + failReason + '】' + (outcome.text ? ' ' + outcome.text : '');
          state.done.add(node.id);
          // Never guess a branch when the judge itself crashed: block all outgoing branches.
          for (const e of plan.edges || []) {
            if (e && e.from === node.id) state.blockedEdges.add(edgeKey(e));
          }
          const fallbackLead = nearestDownstreamLead(node.id);
          if (fallbackLead) {
            state.fallbackLinks.push({ from: node.id, to: fallbackLead.id, label: node.label, failed: true, reason: failReason });
            state.decisions[node.id].fallbackLead = fallbackLead.label;
            state.results[node.id] += '（未擅自选择分支，已直接转交至最近 Lead「' + fallbackLead.label + '」）';
            recomputeBranchPrune();
          } else {
            recomputeBranchPrune();
            haltedReason = '条件节点「' + node.label + '」自身执行失败（' + failReason
              + '），为避免误走分支已停止下游执行。';
          }
          continue;
        }
        const fallbackBranch = branches[0];
        const dec = outcome.decision || {
          branches: [fallbackBranch.id],
          branchLabels: [fallbackBranch.label],
          branch: fallbackBranch.id,
          branchLabel: fallbackBranch.label,
          pass: isDefaultBinary ? fallbackBranch.id === 'true' : true,
          reason: outcome.text || '',
        };
        const matchedIds = Array.isArray(dec.branches) ? dec.branches : (dec.branch ? [dec.branch] : []);
        const matchedLabels = Array.isArray(dec.branchLabels) ? dec.branchLabels : (dec.branchLabel ? [dec.branchLabel] : matchedIds);
        const pass = Boolean(dec.pass);
        const reason = dec.reason || '';
        state.decisions[node.id] = {
          id: node.id,
          label: node.label,
          branches: matchedIds,
          branchLabels: matchedLabels,
          branch: matchedIds[0] || '',
          branchLabel: matchedLabels[0] || '',
          pass,
          reason,
        };
        state.results[node.id] = (matchedIds.length === 0
          ? '【条件判断：未命中任何分支】'
          : (isDefaultBinary
            ? (pass ? '【条件判断：是 / 通过】' : '【条件判断：否 / 未通过】')
            : ('【条件分支：' + matchedLabels.join('、') + '】')))
          + (reason ? ' ' + reason : '');
        state.done.add(node.id);
        const matchedSet = new Set(matchedIds);
        for (const e of plan.edges || []) {
          if (!e || e.from !== node.id) continue;
          const edgeBranch = normalizeBranch(e.branch) || branches[0].id;
          if (!matchedSet.has(edgeBranch)) state.blockedEdges.add(edgeKey(e));
        }
        if (matchedIds.length === 0) {
          // When no condition branch matched, skip intermediate subagent branches
          // and jump directly to the nearest downstream Lead so the user/Lead is notified.
          const fallbackLead = nearestDownstreamLead(node.id);
          if (fallbackLead) {
            state.fallbackLinks.push({ from: node.id, to: fallbackLead.id, label: node.label });
            state.decisions[node.id].fallbackLead = fallbackLead.label;
            state.results[node.id] += '（已跳过中间分支，直接转交至最近 Lead「' + fallbackLead.label + '」）';
          }
        }
        recomputeBranchPrune();
        continue;
      }
      state.results[node.id] = outcome.text;
      if (!outcome.ok) {
        state.failed[node.id] = { id: node.id, label: node.label, reason: outcome.reason || 'unknown' };
        if (outcome.reason === 'activation-failed') activationFailCount += 1;
      } else if (outcome.empty) {
        state.emptyOutputs[node.id] = { id: node.id, label: node.label };
      }
      // If a failing node feeds a condition node, let the condition handle failure routing
      // instead of circuit-breaking the whole run prematurely.
      const routesToCondition = (plan.edges || []).some((e) => e && e.from === node.id
        && byId.get(e.to) && byId.get(e.to).kind === 'condition');
      if (!routesToCondition && isPermissionFailure(outcome)) {
        permBlocked.push(node.label || node.id);
        haltedReason = '检测到权限/沙箱受限导致节点失败（' + permBlocked.join('、')
          + '），已熔断停止启动后续节点以防继续消耗额度。请先检查主对话左下角权限模式，放开后重新运行。';
      } else if (!routesToCondition && activationFailCount >= 2 && !haltedReason) {
        haltedReason = '连续 ' + activationFailCount + ' 个子代理启动失败，已熔断停止后续节点以防继续消耗额度。请检查模型配置或主对话权限后重试。';
      }
      state.done.add(node.id);
      continue;
    }

    const ready = remaining.filter((n) => depsOf(n).every((id) => state.done.has(id)));
    if (!ready.length) return { error: '有节点的依赖无法满足（存在环或悬空依赖）。' };

    const leadNode = ready.find((n) => n.kind === 'lead');
    if (!leadNode) return { error: '没有可执行的节点。' };
    const leadSessions = depsOf(leadNode)
      .filter((id) => (plan.edges || []).some((e) => e.to === leadNode.id && e.from === id && e.type === 'session-ref'))
      .map((id) => ({
        label: labelOf.get(id) || id,
        childId: liveChild.get(String(sid || '') + '::' + id)
          || childByNode.get(String(sid || '') + '::' + id)
          || null,
      }));
    const jumpedEntries = (state.fallbackLinks || []).filter((fl) => fl.to === leadNode.id);
    const failedConds = jumpedEntries.filter((fl) => fl.failed).map((fl) => (fl.label || labelOf.get(fl.from) || fl.from) + '（' + (fl.reason || 'unknown') + '）');
    const unmatchedConds = jumpedEntries.filter((fl) => !fl.failed).map((fl) => fl.label || labelOf.get(fl.from) || fl.from);
    const fallbackParts = [];
    if (failedConds.length) {
      fallbackParts.push('⚠ 条件节点（' + failedConds.join('、') + '）自身执行失败，未擅自选择分支，已跳过中间分支直接转交给你处理；也可调用 canvas_workflow({ retryFailed: true }) 复用上游缓存并只重跑该条件节点及其下游。');
    }
    if (unmatchedConds.length) {
      fallbackParts.push('⚠ 条件节点（' + unmatchedConds.join('、') + '）所有分支均未命中，已跳过中间分支直接转交给你处理。');
    }
    const fallbackNotice = fallbackParts.join(' ');
    const hasDownstreamWork = remaining.some((n) => n.id !== leadNode.id);
    if (!hasDownstreamWork && leadResult === undefined) {
      // Terminal Lead: zero downstream nodes remain, so complete the run directly
      // and hand off final review/delivery to the Lead without a redundant extra turn.
      snapshotLastRun(false);
      if (sid) runBySession.delete(sid);
      saveStore();
      return {
        status: 'done',
        finalLead: {
          label: leadNode.label,
          role: leadNode.role || leadNode.label,
          needs: depsOf(leadNode).map((id) => byId.get(id).label),
        },
        results: state.results,
        labels: state.labels,
        failed: Object.values(state.failed),
        emptyOutputs: Object.values(state.emptyOutputs),
        decisions: Object.values(state.decisions),
        branchSkipped: branchSkippedList(),
        sessions: leadSessions,
        reused,
        skipped,
        hint: (fallbackNotice ? fallbackNotice + ' ' : '')
          + '所有子代理已完成。最后一步由你（Lead 本体）按要求完成终审/汇总后直接向用户交付即可，无需再次调用 canvas_workflow。',
      };
    }
    if (leadResult === undefined) {
      state.waitingLead = {
        id: leadNode.id,
        label: leadNode.label,
        role: leadNode.role || leadNode.label,
      };
      return {
        status: 'need-lead',
        node: {
          label: leadNode.label,
          role: leadNode.role || leadNode.label,
          needs: depsOf(leadNode).map((id) => byId.get(id).label),
        },
        results: state.results,
        labels: state.labels,
        failed: Object.values(state.failed),
        emptyOutputs: Object.values(state.emptyOutputs),
        decisions: Object.values(state.decisions),
        branchSkipped: branchSkippedList(),
        sessions: leadSessions,
        hint: (fallbackNotice ? fallbackNotice + ' ' : '')
          + '这一步由你（Lead 本体）完成。完成后再次调用本工具，把结果放进 leadResult 继续；若需从头重跑可传 reset: true。',
      };
    }
    state.waitingLead = null;
    state.results[leadNode.id] = leadResult;
    state.labels[leadNode.id] = leadNode.label;
    state.done.add(leadNode.id);
    leadResult = undefined;
  }
}

/** Agent-facing guide, shipped as a skill so any agent can load it on demand. */
const SKILL_NAME = 'workflow-canvas';
const SKILL_DESCRIPTION = 'Workflow canvas (画布 / 工作流 / 编排): inspect, draw, edit or run a node graph of DSH subagents — add or re-role nodes, wire typed links, run in parallel waves, handle Lead steps, presets and memory. Load before using canvas_inspect, canvas_generate, canvas_patch or canvas_workflow.';
function skillPath() {
  try {
    return fileURLToPath(new URL('./skills/workflow-canvas/SKILL.md', import.meta.url));
  } catch (_e) {
    return undefined;
  }
}

function readSkillGuide() {
  try {
    const location = skillPath();
    if (!location) return fallbackGuide();
    const raw = readFileSync(location, 'utf8');
    const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
    return match ? raw.slice(match[0].length).trim() : raw.trim();
  } catch (_e) {
    return fallbackGuide();
  }
}

function fallbackGuide() {
  return '# Workflow canvas\n\nThe bundled guide could not be read from this installation.';
}
export function apply(ctx) {
  loadStore();
  ctx.inject(['systemPrompt'], (promptCtx) => {
    try {
      if (promptCtx.systemPrompt && typeof promptCtx.systemPrompt.context === 'function') {
        promptCtx.effect(() => promptCtx.systemPrompt.context({
          name: 'app:workflow-canvas-active',
          order: 950,
          text: (assembleCtx) => buildActiveCanvasContext(sessionIdFromContext(assembleCtx)),
        }), 'workflow-canvas: active context');
      }
    } catch (_e) {
      /* systemPrompt service unavailable */
    }
  });
  ctx.inject(['skills'], (scope) => {
      try {
        scope.effect(() => scope.skills.registerProvider(() => ({
          name: 'dsh-workflow-canvas',
          async list() {
            return {
              candidates: [{
                name: SKILL_NAME,
                description: SKILL_DESCRIPTION,
                invocation: { modelInvocable: true, userInvocable: true },
                provider: 'dsh-workflow-canvas',
                source: 'bundled',
                rank: 0,
                locator: 'dsh-workflow-canvas/skills/workflow-canvas/SKILL.md',
              }],
              complete: true,
            };
          },
          async get(candidate) {
            const { rank, locator, ...summary } = candidate;
            void rank;
            void locator;
            return { ...summary, content: readSkillGuide() };
          },
        })), 'workflow-canvas: skill');
      } catch (_e) {
        /* skill registry unavailable */
      }
    });
  try {
    ctx.inject(['commands'], (scope) => {
      try {
        scope.effect(() => scope.commands.register({
          name: 'canvas-sync',
          description: 'Publish the workflow canvas plan for this session.',
          recordInput: false,
          handler: ({ agent, rawInput }) => {
            try {
              const id = agent && agent.id !== undefined ? String(agent.id) : '';
              if (!id) return { kind: 'error', text: 'no session' };
              canvasBySession.set(id, parsePayload(rawInput));
              runBySession.delete(id);
              saveStore();
              return { kind: 'success', text: 'canvas synced' };
            } catch (error) {
              return { kind: 'error', text: String((error && error.message) || error) };
            }
          },
        }), 'workflow-canvas: sync command');
      } catch (_e) {
        /* command registry unavailable */
      }
    });

    ctx.inject(['tools', 'subagents', 'sessions'], (scope) => {
      try {
        scope.effect(() => scope.tools.register({
          name: 'canvas_generate',
          description: 'Build a workflow canvas for this session from a node/edge sketch. Entry Lead (id="lead") is created automatically with the top-level task — do NOT add a separate entry Lead node; wire first-wave nodes from "lead". Only downstream non-entry Lead nodes pause for need-lead. Load the `workflow-canvas` skill first for node fields and link semantics.',
          parameters: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'Overall task written into the auto-created entry Lead node (id="lead").' },
              nodes: {
                type: 'array',
                description: 'Nodes in any order (do not include an entry Lead — wire from "lead" instead). Give each an id or ref so edges can point at it.',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    ref: { type: 'string', description: 'Temporary handle for edges; the tool assigns the real id.' },
                    entry: { type: 'boolean', description: 'Optional: set true only if customizing the entry Lead node itself.' },
                    kind: { type: 'string', enum: ['agent', 'lead', 'condition'] },
                    label: { type: 'string' },
                    role: { type: 'string' },
                    task: { type: 'string' },
                    provider: { type: 'string' },
                    model: { type: 'string' },
                    reasoning: { type: 'string' },
                    preset: { type: 'string' },
                    structured: { type: 'boolean' },
                    keepSession: { type: 'boolean' },
                    fallbackModel: { type: 'string' },
                    fallbackProvider: { type: 'string' },
                    branches: {
                      type: 'array',
                      description: 'Optional (condition nodes only): custom switch/case branch names (strings or { id, label }, 2 or more). Omit for default true/false.',
                      items: {},
                    },
                    multiMatch: {
                      type: 'boolean',
                      description: 'Optional (condition nodes only): true to allow matching multiple branches in parallel; false (default) picks at most 1 branch (or none if unmatched).',
                    },
                  },
                },
              },
              edges: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    from: { type: 'string' },
                    to: { type: 'string' },
                    type: { type: 'string', enum: ['prompt', 'structured', 'session-ref'] },
                    branch: { type: 'string', description: 'For edges leaving a condition node: "true" / "false" (default binary) or one of the condition node branch ids.' },
                  },
                  required: ['from', 'to'],
                },
              },
            },
            required: ['nodes'],
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                canvas: { type: 'object' },
                delivered: { type: 'boolean' },
                warnings: { type: 'array', items: { type: 'string' } },
                error: { type: 'string' },
              },
            },
            render: (_args, value) => {
              const v = value || {};
              if (typeof v.error === 'string') return [{ type: 'text', text: v.error }];
              const canvas = v.canvas || {};
              const nodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
              const edges = Array.isArray(canvas.edges) ? canvas.edges : [];
              const lines = nodes.map((n) => '- [' + n.id + '] '
                + (n.kind === 'lead' ? '〔Lead〕' : (n.kind === 'condition' ? '〔条件〕' : ''))
                + n.label
                + (n.role ? '：' + n.role : ''));
              const warnBlock = Array.isArray(v.warnings) && v.warnings.length
                ? '\n\n⚠ 结构提示：\n' + v.warnings.map((w) => '- ' + w).join('\n')
                : '';
              return [{
                type: 'text',
                text: '已生成画布：' + nodes.length + ' 个节点、' + edges.length + ' 条连线\n'
                  + lines.join('\n')
                  + warnBlock
                  + (v.delivered
                    ? '\n\n画布已经自动同步到右侧画布，直接看即可（若没出现，点画布上的「⊡ 全览」）。'
                    : '\n\n**下一步**：点画布右上角「⋯ → ⇩ 导入」，它会把这段画布数据装进当前画布。')
                  + '\n```json canvas\n'
                  + JSON.stringify(canvas) + '\n```',
              }];
            },
          },
          execute: (args, exec) => {
            try {
              const result = normalizeCanvas(args || {});
              if (result.error) return { error: result.error };
              const warnings = Array.isArray(result.warnings) ? result.warnings : [];
              const agent = exec && exec.agent;
              const sid = agent && agent.id !== undefined ? String(agent.id) : '';
              const previous = sid ? canvasBySession.get(sid) : undefined;
              const nextEnabled = previous ? Boolean(previous.enabled) : true;
              const canvas = { nodes: result.nodes, edges: result.edges, enabled: nextEnabled };
              const delivered = sid ? publishCanvas(scope, sid, canvas) : false;
              if (sid) {
                canvasBySession.set(sid, {
                  enabled: nextEnabled,
                  plan: {
                    task: String(result.task || (args && args.task) || ''),
                    nodes: withoutEntry(canvas.nodes),
                    edges: canvas.edges,
                  },
                });
                runBySession.delete(sid);
                lastRunBySession.delete(sid);
                saveStore();
              }
              return { canvas, delivered, warnings };
            } catch (error) {
              return { error: String((error && error.message) || error) };
            }
          },
        }), 'workflow-canvas: generate tool');
      } catch (_e) {
        /* tool registry unavailable */
      }
    });

    ctx.inject(['tools', 'subagents', 'sessions'], (scope) => {
      try {
        scope.effect(() => scope.tools.register({
          name: 'canvas_patch',
          description: 'Edit the current canvas in place: update the given nodes by id, add new ones, remove some, and add or remove links. Everything else, including node positions, is left alone. Prefer this over canvas_generate for edits; load the `workflow-canvas` skill first if unsure.',
          parameters: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'Optional: update the overall task in the entry Lead node.' },
              nodes: { type: 'array', description: 'Nodes to update or add. Existing ids are merged field by field.', items: { type: 'object' } },
              removeNodes: { type: 'array', description: 'Node ids to delete.', items: { type: 'string' } },
              edges: { type: 'array', description: 'Links to add.', items: { type: 'object' } },
              removeEdges: { type: 'array', description: 'Links to delete, matched by from/to.', items: { type: 'object' } },
            },
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                delivered: { type: 'boolean' },
                summary: { type: 'string' },
                warnings: { type: 'array', items: { type: 'string' } },
                error: { type: 'string' },
              },
            },
            render: (_a, value) => {
              const v = value || {};
              if (typeof v.error === 'string') return [{ type: 'text', text: v.error }];
              const warnBlock = Array.isArray(v.warnings) && v.warnings.length
                ? '\n⚠ 结构提示：\n' + v.warnings.map((w) => '- ' + w).join('\n')
                : '';
              return [{ type: 'text', text: v.summary + (v.delivered ? '（画布已就地更新）' : '（画布不可达，未应用）') + warnBlock }];
            },
          },
          execute: (args, exec) => {
            try {
              const agent = exec && exec.agent;
              const sid = agent && agent.id !== undefined ? String(agent.id) : '';
              const payload = sid ? canvasBySession.get(sid) : undefined;
              if (!payload || !payload.plan) return { error: '当前会话还没有画布数据，先用「启用」同步一次。' };
              const patched = applyPatch(payload.plan, args);
              const nextPlan = patched.plan;
              canvasBySession.set(sid, { enabled: payload.enabled, plan: nextPlan });
              runBySession.delete(sid);
              saveStore();
              const patchDoc = {
                mode: 'merge',
                nodes: nextPlan.nodes,
                edges: nextPlan.edges,
                removeNodes: patched.removed,
                removeEdges: patched.removeEdges,
              };
              if (patched.taskPatched) patchDoc.task = nextPlan.task;
              const delivered = publishCanvas(scope, sid, patchDoc);
              const warnings = analyzeCanvasWarnings(nextPlan.nodes, nextPlan.edges);
              const summary = '已更新 ' + patched.touched.length + ' 个节点'
                + (patched.taskPatched ? '、已更新总任务' : '')
                + '、删除 ' + patched.removed.length + ' 个、连线 ' + nextPlan.edges.length + ' 条';
              return { delivered, summary, warnings };
            } catch (error) {
              return { error: String((error && error.message) || error) };
            }
          },
        }), 'workflow-canvas: patch tool');
      } catch (_e) {
        /* tool registry unavailable */
      }
    });

    ctx.inject(['tools'], (scope) => {
      try {
        scope.effect(() => scope.tools.register({
          name: 'canvas_inspect',
          description: 'Read the current session workflow canvas (enabled status, overall task, nodes with ids/models/roles, links, and whether a run is paused at a Lead step). Call this before canvas_patch when the user edited the canvas manually or loaded a preset.',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                hasCanvas: { type: 'boolean' },
                enabled: { type: 'boolean' },
                task: { type: 'string' },
                nodes: { type: 'array' },
                edges: { type: 'array' },
                warnings: { type: 'array', items: { type: 'string' } },
                paused: { type: 'boolean' },
                error: { type: 'string' },
              },
            },
            render: (_args, value) => {
              const v = value || {};
              if (!v.hasCanvas) {
                return [{ type: 'text', text: '当前会话尚未同步画布。请让用户在右侧 Workflow 画布点「启用」或「同步」，或直接用 canvas_generate 生成新画布。' }];
              }
              const head = [
                '画布状态：' + (v.enabled ? '● 已启用' : '○ 已禁用') + (v.paused ? '（当前暂停在 Lead 步骤）' : ''),
                '总任务：' + (v.task || '（未填写，运行时可通过 task 参数指定）'),
              ];
              if (v.error) head.push('校验错误：' + v.error);
              const warnBlock = Array.isArray(v.warnings) && v.warnings.length
                ? '\n\n⚠ 结构提示：\n' + v.warnings.map((w) => '- ' + w).join('\n')
                : '';
              const nodeLines = (v.nodes || []).map((n) => {
                const flags = [];
                if (n.kind === 'lead') flags.push('Lead');
                if (n.kind === 'condition') {
                  flags.push('条件' + (Array.isArray(n.branches) && n.branches.length >= 2
                    ? ':' + n.branches.map((b) => b.label || b.id).join('/')
                    : ''));
                  if (n.multiMatch) flags.push('多选');
                }
                if (n.model) flags.push(n.model);
                if (n.reasoning) flags.push('reasoning=' + n.reasoning);
                if (n.preset === 'minimal') flags.push('minimal');
                if (n.keepSession) flags.push('记忆');
                if (n.fallbackModel) flags.push('备用=' + n.fallbackModel);
                return '- [' + n.id + '] ' + n.label
                  + (flags.length ? ' (' + flags.join(', ') + ')' : '')
                  + (n.role ? '：' + n.role : '');
              });
              const edgeLines = (v.edges || []).map((e) => '- ' + e.from
                + ' --(' + e.type + (e.branch ? ':' + e.branch : '') + ')--> ' + e.to);
              return [{
                type: 'text',
                text: head.join('\n')
                  + warnBlock
                  + '\n\n节点（' + nodeLines.length + '）：\n' + (nodeLines.join('\n') || '（无）')
                  + '\n\n连线（' + edgeLines.length + '）：\n' + (edgeLines.join('\n') || '（无）'),
              }];
            },
          },
          execute: (_args, exec) => {
            const agent = exec && exec.agent;
            const sid = agent && agent.id !== undefined ? String(agent.id) : '';
            return inspectPlan(sid);
          },
        }), 'workflow-canvas: inspect tool');
      } catch (_e) {
        /* tool registry unavailable */
      }
    });

    ctx.inject(['tools', 'subagents'], (scope) => {
      try {
        scope.effect(() => scope.tools.register({
          name: 'canvas_workflow',
          description: 'Run the workflow canvas of the current session. Executes subagent nodes in parallel waves; when a Lead node is reached it returns status "need-lead" and expects a follow-up call carrying leadResult. Supports optional `task` to override the entry Lead task and `reset: true` to restart from scratch. Load the `workflow-canvas` skill first when unsure.',
          parameters: {
            type: 'object',
            properties: {
              leadResult: { type: 'string', description: 'Your own output for the Lead step that was just requested.' },
              task: { type: 'string', description: 'Optional overall task overriding the entry Lead task for this run (useful for reusing a preset).' },
              reset: { type: 'boolean', description: 'Discard any paused run progress and start from the beginning.' },
              retryFailed: { type: 'boolean', description: 'Reuse succeeded nodes from the previous run and re-run only failed, empty, or unfinished nodes along with their downstream.' },
              fromNodes: { type: 'array', items: { type: 'string' }, description: 'Re-run only the specified node ids (or labels) and their downstream, reusing all other succeeded nodes from the previous run.' },
              clearMemory: { type: 'boolean', description: 'Forget saved subagent sessions (keepSession memory) for this session before running so every node starts fresh.' },
              maxParallel: { type: 'integer', minimum: 1, maximum: 8, description: 'Optional concurrency limit override (1–8, default 4).' },
            },
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                status: { type: 'string' },
                node: { type: 'object' },
                finalLead: { type: 'object' },
                results: { type: 'object' },
                labels: { type: 'object' },
                failed: { type: 'array' },
                emptyOutputs: { type: 'array' },
                decisions: { type: 'array' },
                branchSkipped: { type: 'array' },
                sessions: { type: 'array' },
                reused: { type: 'array' },
                skipped: { type: 'array' },
                hint: { type: 'string' },
                error: { type: 'string' },
              },
            },
            render: (_args, value) => {
              const v = value || {};
              if (typeof v.error === 'string') return [{ type: 'text', text: v.error }];
              const results = v.results || {};
              const labels = v.labels || {};
              const blocks = Object.keys(results).map((id) => {
                const text = typeof results[id] === 'string' ? results[id] : JSON.stringify(results[id]);
                return '## ' + (labels[id] || id) + '\n' + text;
              });
              const body = blocks.length ? blocks.join('\n\n') : '（暂无上游结果）';
              const failedList = Array.isArray(v.failed) && v.failed.length
                ? '\n\n⚠ 失败节点：' + v.failed.map((f) => (f.label || f.id) + '（' + (f.reason || 'unknown') + '）').join('、')
                : '';
              const emptyList = Array.isArray(v.emptyOutputs) && v.emptyOutputs.length
                ? '\n\n⚠ 未返回交付文本的节点（请核查其实际产物，切勿直接当作已完成）：'
                  + v.emptyOutputs.map((e) => e.label || e.id).join('、')
                : '';
              const decisionList = Array.isArray(v.decisions) && v.decisions.length
                ? '\n\n条件分支判决：' + v.decisions.map((d) => {
                  if (d.failed) {
                    return (d.label || d.id) + ' → ⚠ 自身执行失败' + (d.reason ? '（' + d.reason + '）' : '');
                  }
                  const ids = Array.isArray(d.branches) ? d.branches : (d.branch ? [d.branch] : []);
                  const labels = Array.isArray(d.branchLabels) ? d.branchLabels : (d.branchLabel ? [d.branchLabel] : ids);
                  if (!ids.length) {
                    return (d.label || d.id) + ' → 未命中任何分支' + (d.reason ? '（' + d.reason + '）' : '');
                  }
                  const isDefault = ids.length === 1
                    && (ids[0] === 'true' || ids[0] === 'false')
                    && (!labels[0] || labels[0] === '是' || labels[0] === '否' || labels[0] === 'Yes' || labels[0] === 'No');
                  const chosen = isDefault ? (d.pass ? '✓ 是' : '✕ 否') : labels.join(' + ');
                  return (d.label || d.id) + ' → ' + chosen + (d.reason ? '（' + d.reason + '）' : '');
                }).join('；')
                : '';
              const branchSkipNote = Array.isArray(v.branchSkipped) && v.branchSkipped.length
                ? '\n\n条件未命中已跳过：' + v.branchSkipped.join('、')
                : '';
              if (v.status === 'need-lead') {
                const n = v.node || {};
                const handed = Array.isArray(v.sessions) ? v.sessions.filter((s) => s && s.childId) : [];
                const handover = handed.length
                  ? '\n\n可用会话（session 连线）：' + handed.map((s) => s.label + ' → ' + s.childId).join('；')
                    + '\n需要追问时，直接给对应子代理发消息即可，它们仍在上游会话里。'
                  : '';
                return [{
                  type: 'text',
                  text: '需要你（Lead）完成「' + n.label + '」：' + n.role
                    + '\n需要用到：' + ((n.needs && n.needs.length) ? n.needs.join('、') : '（无上游）')
                    + decisionList
                    + failedList
                    + emptyList
                    + '\n\n已完成节点的结果：\n' + body
                    + handover
                    + branchSkipNote
                    + '\n\n' + (v.hint || ''),
                }];
              }
              if (v.status === 'done') {
                const skip = Array.isArray(v.skipped) && v.skipped.length
                  ? '\n\n已跳过（未连线）：' + v.skipped.join('、')
                  : '';
                const reusedNote = Array.isArray(v.reused) && v.reused.length
                  ? '\n\n已复用上次成功缓存（未重复消耗）：' + v.reused.join('、')
                  : '';
                if (v.finalLead) {
                  const fl = v.finalLead;
                  const handed = Array.isArray(v.sessions) ? v.sessions.filter((s) => s && s.childId) : [];
                  const handover = handed.length
                    ? '\n\n可用会话（session 连线）：' + handed.map((s) => s.label + ' → ' + s.childId).join('；')
                      + '\n如需局部追问或返工，可直接给对应子代理发消息。'
                    : '';
                  return [{
                    type: 'text',
                    text: '所有子代理已完成，现在进入终审 Lead 步骤「' + fl.label + '」：' + fl.role
                      + '\n需要用到：' + ((fl.needs && fl.needs.length) ? fl.needs.join('、') : '（无上游）')
                      + decisionList
                      + failedList
                      + emptyList
                      + '\n\n已完成节点的结果：\n' + body
                      + handover
                      + branchSkipNote
                      + reusedNote
                      + skip
                      + '\n\n' + (v.hint || ''),
                  }];
                }
                return [{ type: 'text', text: '画布执行完成。' + decisionList + failedList + emptyList + '\n\n' + body + branchSkipNote + reusedNote + skip }];
              }
              return [{ type: 'text', text: JSON.stringify(v) }];
            },
          },
          execute: (args, exec) => runPlan(scope, args || {}, exec),
        }), 'workflow-canvas: run tool');
      } catch (_e) {
        /* tool registry unavailable */
      }
    });
  } catch (_e) {
    /* never fail the plugin load because of the bridge */
  }
}

export {
  orderNodes,
  upstreamOf,
  downstreamLabels,
  briefFor,
  normalizeBranches,
  parseConditionDecision,
  withoutEntry,
  analyzeCanvasWarnings,
  normalizeCanvas,
  applyPatch,
  inspectPlan,
  sessionIdFromContext,
  buildActiveCanvasContext,
  isPermissionFailure,
  runPlan,
  executePlan,
};
