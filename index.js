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
/** Live AbortController & active child session ids per executing Session id. */
const activeRunBySession = new Map();
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

const MAX_LOOP_ITERATIONS = 10;
const DEFAULT_LOOP_ITERATIONS = 3;
const MAX_GLOBAL_LOOPS = 20;

function normalizeMaxIterations(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return DEFAULT_LOOP_ITERATIONS;
  return Math.max(1, Math.min(MAX_LOOP_ITERATIONS, Math.floor(n)));
}

function isLoopEdge(e) {
  return Boolean(e && e.loop === true);
}

function forwardEdgesOf(edges) {
  return (Array.isArray(edges) ? edges : []).filter((e) => e && !e.loop);
}

/**
 * Compute the set of node ids strictly inside a controlled loop edge (from target -> ... -> source)
 * over forward edges: `descendants(loopEdge.to) ∩ ancestors(loopEdge.from)` (inclusive).
 * Returns an empty Set if `loopEdge.from` is not reachable from `loopEdge.to` over forward edges.
 */
function loopMemberIds(nodes, edges, loopEdge) {
  if (!loopEdge || !loopEdge.from || !loopEdge.to || loopEdge.to === 'lead') return new Set();
  const fwd = new Map();
  const rev = new Map();
  for (const e of forwardEdgesOf(edges)) {
    if (!e.from || !e.to) continue;
    if (!fwd.has(e.from)) fwd.set(e.from, []);
    fwd.get(e.from).push(e.to);
    if (!rev.has(e.to)) rev.set(e.to, []);
    rev.get(e.to).push(e.from);
  }
  const desc = new Set([loopEdge.to]);
  const q1 = [loopEdge.to];
  for (let i = 0; i < q1.length; i += 1) {
    for (const next of fwd.get(q1[i]) || []) {
      if (!desc.has(next)) { desc.add(next); q1.push(next); }
    }
  }
  if (!desc.has(loopEdge.from)) return new Set();
  const anc = new Set([loopEdge.from]);
  const q2 = [loopEdge.from];
  for (let i = 0; i < q2.length; i += 1) {
    for (const prev of rev.get(q2[i]) || []) {
      if (!anc.has(prev)) { anc.add(prev); q2.push(prev); }
    }
  }
  const members = new Set();
  for (const id of desc) {
    if (anc.has(id)) members.add(id);
  }
  return members;
}

/** Kahn topological order over every plan node (ignoring controlled loop back-edges). */
function orderNodes(plan) {
  const nodes = plan.nodes || [];
  const edges = forwardEdgesOf(plan.edges || []);
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
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i];
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
  return forwardEdgesOf(plan.edges || [])
    .filter((e) => e.to === node.id)
    .map((e) => ({ edge: e, from: byId.get(e.from) }))
    .filter((x) => x.from);
}

function downstreamLabels(plan, node) {
  const byId = new Map((plan.nodes || []).map((n) => [n.id, n]));
  return forwardEdgesOf(plan.edges || [])
    .filter((e) => e.from === node.id)
    .map((e) => (byId.get(e.to) || {}).label)
    .filter(Boolean);
}

function normalizeKind(rawKind) {
  if (rawKind === 'lead') return 'lead';
  if (rawKind === 'condition') return 'condition';
  return 'agent';
}

/**
 * Normalize a reference list (paths, URLs, or rules attached to a node or entry Lead).
 * Accepts string arrays or `{ text | path }` objects; capped at 16 unique non-empty items.
 */
function normalizeRefs(rawRefs) {
  if (!Array.isArray(rawRefs) || !rawRefs.length) return null;
  const out = [];
  const seen = new Set();
  for (const raw of rawRefs) {
    if (out.length >= 16) break;
    let s = '';
    if (typeof raw === 'string') s = raw.trim();
    else if (raw && typeof raw === 'object') {
      s = String(raw.text !== undefined ? raw.text : (raw.path !== undefined ? raw.path : '')).trim();
    }
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.length ? out : null;
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

function briefFor(plan, node, results, failedMap, prunedSet, loopCtx) {
  const ups = upstreamOf(plan, node).filter((u) => !(prunedSet && prunedSet.has(u.from.id)));
  const downs = downstreamLabels(plan, node);
  const head = [];
  if (node.kind === 'condition') {
    const outEdges = (plan.edges || []).filter((e) => e.from === node.id);
    const byId = new Map((plan.nodes || []).map((n) => [n.id, n]));
    const { branches, isDefaultBinary, multiMatch } = conditionBranches(node);
    const fmtTarget = (e) => {
      const lbl = (byId.get(e.to) || {}).label || e.to;
      return e.loop ? (lbl + '（↺ 回环重做，最多 ' + normalizeMaxIterations(e.maxIterations) + ' 次）') : lbl;
    };
    head.push('【工作流条件判断节点】你负责判断当前工作流接下来走哪条分支（「' + node.label + '」）。');
    head.push('【总任务】' + plan.task);
    if (isDefaultBinary) {
      const yesTargets = outEdges.filter((e) => (normalizeBranch(e.branch) || 'true') === 'true').map(fmtTarget);
      const noTargets = outEdges.filter((e) => normalizeBranch(e.branch) === 'false').map(fmtTarget);
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
          .map(fmtTarget);
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
  const mergedRefs = [];
  const seenRefs = new Set();
  for (const r of (normalizeRefs(plan && plan.refs) || []).concat(normalizeRefs(node && node.refs) || [])) {
    if (!seenRefs.has(r)) { seenRefs.add(r); mergedRefs.push(r); }
  }
  if (mergedRefs.length) {
    head.push('【参考资料 / 约束】\n' + mergedRefs.map((r) => '- ' + r).join('\n'));
  }
  if (loopCtx && loopCtx.feedback) {
    const fb = loopCtx.feedback;
    const lines = [
      '【第 ' + fb.retry + '/' + fb.max + ' 次回环修正反馈】下游条件节点「' + (fb.sourceLabel || '条件判断') + '」判定上一轮未通过，请针对以下问题修正后输出最新结果：',
      '- 打回理由：' + (fb.reason || '未达预期'),
    ];
    if (fb.lastSummary) lines.push('- 上一轮环内参考摘要：\n' + fb.lastSummary);
    head.push(lines.join('\n'));
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

function extractResultError(result) {
  if (!result || typeof result !== 'object') return '';
  const candidates = [result.error, result.errorMessage, result.message, result.failureReason];
  for (const raw of candidates) {
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (raw && typeof raw === 'object') {
      const msg = raw.message || raw.detail || raw.code;
      if (typeof msg === 'string' && msg.trim()) return msg.trim();
      try {
        const s = JSON.stringify(raw);
        if (s && s !== '{}') return s.slice(0, 240);
      } catch (_e) { /* ignore */ }
    }
  }
  return '';
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
  if (text) return text;
  const errDetail = extractResultError(result);
  const stop = (result && result.stopReason) || (errDetail ? 'error' : 'no-output');
  return errDetail ? '[' + stop + '] ' + errDetail : '[' + stop + ']';
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

function buildLoopWarmPrompt(node, loopCtx) {
  const fb = loopCtx && loopCtx.feedback;
  if (!fb) return null;
  const lines = [
    '【第 ' + fb.retry + '/' + fb.max + ' 次回环修正】下游条件节点「' + (fb.sourceLabel || '条件判断') + '」判定上一轮未通过，请结合以下反馈直接在当前会话上下文中修正并输出最新交付结果（无需重复叙述过程）：',
    '- 打回理由：' + (fb.reason || '未达预期'),
  ];
  if (fb.lastSummary) lines.push('- 上一轮环内参考摘要：\n' + fb.lastSummary);
  if (node.role) lines.push('- 你的职责提醒：' + node.role);
  return lines.join('\n');
}

async function spawnOnce(scope, plan, node, results, parent, signal, route, forcedChild, sid, failedMap, prunedSet, loopCtx) {
  const childKey = (id) => String(sid || '') + '::' + id;
  const isCondition = node.kind === 'condition';
  const fullBrief = briefFor(plan, node, results, failedMap, prunedSet, loopCtx);
  const warmPrompt = (!isCondition && loopCtx && loopCtx.warmChildId && loopCtx.feedback)
    ? buildLoopWarmPrompt(node, loopCtx)
    : null;
  const spec = {
    provider: 'spawn',
    label: node.label + '#' + node.id,
    prompt: [{ type: 'text', text: fullBrief }],
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
  const allowSchema = !(route && route.noSchema);
  if (isCondition) {
    const { branches, isDefaultBinary, multiMatch } = conditionBranches(node);
    spec.agentPreset = 'minimal';
    if (allowSchema) {
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
    }
  } else {
    if (node.preset) spec.agentPreset = node.preset;
    const wantsStructured = Boolean(node.structured)
      || (plan.edges || []).some((e) => e.from === node.id && e.type === 'structured');
    if (wantsStructured && allowSchema) {
      spec.outputSchema = {
        type: 'object',
        additionalProperties: true,
        description: 'Return the result as a JSON object so downstream steps can consume it.',
      };
    }
  }

  const run = async (childId, overridePrompt) => {
    // Guard before every activation so an interrupted run can never spawn fresh/fallback zombies.
    if (signal && signal.aborted) {
      return { ok: false, empty: false, reason: 'aborted', text: '已取消', childId: '' };
    }
    const baseSpec = overridePrompt
      ? { ...spec, prompt: [{ type: 'text', text: overridePrompt }] }
      : spec;
    const withChild = childId ? { ...baseSpec, childId } : baseSpec;
    let activation;
    try {
      activation = await scope.subagents.startActivation(withChild);
    } catch (error) {
      const message = String((error && error.message) || error);
      return { ok: false, text: '启动失败：' + message, reason: 'activation-failed', errorDetail: message };
    }
    try {
      if (activation && activation.childId) {
        const cid = String(activation.childId);
        liveChild.set(childKey(node.id), cid);
        // Only overwrite the persisted memory slot when Memory is ON, so a
        // temporary keepSession=false experiment never destroys saved memory.
        if (node.keepSession) childByNode.set(childKey(node.id), cid);
        const activeRec = sid ? activeRunBySession.get(String(sid)) : null;
        if (activeRec && activeRec.childIds) activeRec.childIds.add(cid);
      }
      let result;
      try {
        result = await activation.result;
      } catch (error) {
        const message = String((error && error.message) || error);
        return { ok: false, text: '运行失败：' + message, reason: 'run-failed', errorDetail: message };
      }
      const outText = textOf(result);
      const errDetail = extractResultError(result);
      const outcome = {
        ok: !failed(result),
        text: outText,
        reason: result && result.stopReason,
        errorDetail: errDetail,
        empty: isEmptyOutput(result),
        childId: activation && activation.childId ? String(activation.childId) : '',
      };
      if (isCondition) {
        outcome.decision = parseConditionDecision(result, outText, node);
      }
      return outcome;
    } finally {
      if (activation && activation.childId && sid) {
        const activeRec = activeRunBySession.get(String(sid));
        if (activeRec && activeRec.childIds) activeRec.childIds.delete(String(activation.childId));
      }
      try { await activation.dispose(); } catch (_e) { /* ignore */ }
    }
  };

  // On a controlled loop retry where the previous run of this node was healthy,
  // resume its warm child session with a concise incremental correction prompt.
  if (warmPrompt && loopCtx && loopCtx.warmChildId && !forcedChild) {
    const continued = await run(loopCtx.warmChildId, warmPrompt);
    if (signal && signal.aborted) return continued;
    if (continued.ok) {
      liveChild.set(childKey(node.id), continued.childId || loopCtx.warmChildId);
      return { ...continued, warmReused: true };
    }
    if (continued.reason !== 'activation-failed') {
      return continued;
    }
    /* warm session refused: fall through to a fresh session with the full brief + feedback */
  }

  // A `session` edge means "continue the upstream node's conversation": run this
  // step inside that child session instead of starting a fresh one.
  if (forcedChild) {
    const continued = await run(forcedChild);
    if (signal && signal.aborted) return continued;
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
      if (signal && signal.aborted) return resumed;
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

function formatModelLabel(provider, model) {
  const p = typeof provider === 'string' ? provider.trim() : '';
  const m = typeof model === 'string' ? model.trim() : '';
  if (p && m) return p + '/' + m;
  return m || p || '';
}

async function spawnNode(scope, plan, node, results, parent, signal, sid, failedMap, prunedSet, loopCtx) {
  const primaryModel = formatModelLabel(node.provider, node.model);
  if (signal && signal.aborted) {
    return { ok: false, empty: false, reason: 'aborted', text: '已取消', childId: '', modelUsed: primaryModel, fallbackUsed: false, sessionContinued: false };
  }
  const continueFrom = forwardEdgesOf(plan.edges || [])
    .filter((e) => e.to === node.id && e.type === 'session-ref' && !(prunedSet && prunedSet.has(e.from)))
    .map((e) => liveChild.get(String(sid || '') + '::' + e.from)
      || childByNode.get(String(sid || '') + '::' + e.from))
    .find((id) => typeof id === 'string');

  if (continueFrom) {
    const continued = await spawnOnce(scope, plan, node, results, parent, signal, undefined, continueFrom, sid, failedMap, prunedSet, loopCtx);
    if (signal && signal.aborted) return continued;
    if (continued.ok) {
      const out = {
        ok: true,
        empty: Boolean(continued.empty),
        text: continued.text + '\n（已在上游会话中继续）',
        childId: continued.childId || continueFrom,
        modelUsed: primaryModel,
        fallbackUsed: false,
        sessionContinued: true,
      };
      if (continued.decision) out.decision = continued.decision;
      return out;
    }
  }

  let first = await spawnOnce(scope, plan, node, results, parent, signal, undefined, undefined, sid, failedMap, prunedSet, loopCtx);
  if (signal && signal.aborted) return first;
  // Many models/proxies reject strict `outputSchema` (`json_schema`) with stopReason='error'.
  // For condition/structured nodes, automatically retry once on the same model without outputSchema
  // so `parseConditionDecision` can parse plain-text JSON before giving up or falling back.
  const usedSchema = node.kind === 'condition'
    || Boolean(node.structured)
    || (plan.edges || []).some((e) => e.from === node.id && e.type === 'structured');
  if (!first.ok && usedSchema && first.reason !== 'activation-failed' && first.reason !== 'aborted' && !isPermissionFailure(first)) {
    const plainRetry = await spawnOnce(scope, plan, node, results, parent, signal, { noSchema: true }, undefined, sid, failedMap, prunedSet, loopCtx);
    if (signal && signal.aborted) return plainRetry;
    if (plainRetry.ok) {
      first = plainRetry;
    } else if (plainRetry.errorDetail && !first.errorDetail) {
      first = plainRetry;
    }
  }
  if (first.ok) {
    const out = {
      ok: true,
      empty: Boolean(first.empty),
      text: first.text,
      childId: first.childId || '',
      modelUsed: primaryModel,
      fallbackUsed: false,
      sessionContinued: Boolean(first.warmReused),
    };
    if (first.decision) out.decision = first.decision;
    return out;
  }
  if (!node.fallbackModel && !node.fallbackProvider) {
    const reason = first.reason || 'unknown';
    const detail = first.errorDetail || '';
    const modelTag = primaryModel ? ('模型 ' + primaryModel) : '默认模型';
    const suffix = detail ? (reason + ' — ' + detail) : reason;
    return {
      ok: false,
      empty: false,
      reason,
      errorDetail: detail,
      text: first.text + '\n（' + modelTag + ' 执行失败：' + suffix + '）',
      childId: first.childId || '',
      modelUsed: primaryModel,
      fallbackUsed: false,
      sessionContinued: false,
    };
  }
  const fallbackLabel = formatModelLabel(node.fallbackProvider || node.provider, node.fallbackModel || node.model);
  let retry = await spawnOnce(scope, plan, node, results, parent, signal, {
    provider: node.fallbackProvider,
    model: node.fallbackModel,
  }, undefined, sid, failedMap, prunedSet, loopCtx);
  if (signal && signal.aborted) return retry;
  if (!retry.ok && usedSchema && retry.reason !== 'activation-failed' && retry.reason !== 'aborted' && !isPermissionFailure(retry)) {
    const plainFallback = await spawnOnce(scope, plan, node, results, parent, signal, {
      provider: node.fallbackProvider,
      model: node.fallbackModel,
      noSchema: true,
    }, undefined, sid, failedMap, prunedSet, loopCtx);
    if (signal && signal.aborted) return plainFallback;
    if (plainFallback.ok || (plainFallback.errorDetail && !retry.errorDetail)) retry = plainFallback;
  }
  if (retry.ok) {
    const out = {
      ok: true,
      empty: Boolean(retry.empty),
      text: retry.text + '\n（已用备用模型重试成功）',
      childId: retry.childId || '',
      modelUsed: fallbackLabel,
      fallbackUsed: true,
      sessionContinued: Boolean(retry.warmReused),
    };
    if (retry.decision) out.decision = retry.decision;
    return out;
  }
  const reason = retry.reason || 'unknown';
  const retryDetail = retry.errorDetail || '';
  const suffix = retryDetail ? (reason + ' — ' + retryDetail) : reason;
  return {
    ok: false,
    empty: false,
    reason,
    errorDetail: retryDetail,
    text: retry.text + '\n（备用模型 ' + (fallbackLabel || '默认') + ' 重试仍失败：' + suffix + '）',
    childId: retry.childId || first.childId || '',
    modelUsed: fallbackLabel,
    fallbackUsed: true,
    sessionContinued: false,
  };
}

/** Ids reachable from the entry Lead via O(V + E) BFS over forward edges; every other node is skipped at run time. */
function reachableFrom(plan) {
  const adj = new Map();
  for (const e of forwardEdgesOf(plan && plan.edges)) {
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
 *   - solo chained Leads (zero reachable subagent upstream and blank role)
 *   - dangling dead-end subagents (zero outgoing edges while an active non-ancestor downstream Lead exists)
 */
function inactiveNodeSets(nodes, edges) {
  const list = withoutEntry(nodes);
  const linkList = Array.isArray(edges) ? edges : [];
  const fwdLinks = forwardEdgesOf(linkList);
  const reachable = reachableFrom({ edges: fwdLinks });
  const byId = new Map(list.map((n) => [n.id, n]));

  const soloLeads = new Set();
  for (const n of list) {
    if (n.kind !== 'lead' || !reachable.has(n.id)) continue;
    const hasAgentUp = fwdLinks.some((e) => {
      if (!e || e.to !== n.id || !reachable.has(e.from) || e.from === 'lead') return false;
      const src = byId.get(e.from);
      return Boolean(src && src.kind !== 'lead');
    });
    const hasRole = Boolean(String(n.role || '').trim());
    if (!hasAgentUp && !hasRole) soloLeads.add(n.id);
  }

  const deadEnds = new Set();
  const activeLeads = list.filter((n) => n.kind === 'lead' && reachable.has(n.id) && !soloLeads.has(n.id));
  if (activeLeads.length) {
    const hasOut = new Set(linkList.map((e) => e.from));
    const parents = new Map();
    for (const e of fwdLinks) {
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
 * Validate controlled loop edges: each loop edge must leave a condition node, target a strict
 * forward-path ancestor (never entry Lead), and not overlap/cross another loop edge's body.
 */
function validateLoopEdges(nodes, edges) {
  const list = withoutEntry(nodes);
  const byId = new Map(list.map((n) => [n.id, n]));
  const linkList = Array.isArray(edges) ? edges : [];
  const loopEdges = linkList.filter((e) => isLoopEdge(e));
  const errors = [];
  const seenMembers = new Map();
  for (const le of loopEdges) {
    const src = byId.get(le.from);
    const dst = byId.get(le.to);
    if (!src || src.kind !== 'condition') {
      errors.push('回环边起点必须是条件判断节点（' + le.from + ' → ' + le.to + '）。');
      continue;
    }
    if (!dst || le.to === 'lead') {
      errors.push('回环边不能指向入口 Lead 或不存在的节点（' + le.from + ' → ' + le.to + '）。');
      continue;
    }
    const members = loopMemberIds(list, linkList, le);
    if (!members.size) {
      errors.push('回环边目标「' + (dst.label || dst.id) + '」不是「' + (src.label || src.id) + '」的上游祖先节点。');
      continue;
    }
    let overlap = false;
    for (const mid of members) {
      if (seenMembers.has(mid)) { overlap = true; break; }
    }
    if (overlap) {
      errors.push('检测到交叉或嵌套回环（涉及节点「' + (dst.label || dst.id) + '」），暂不支持交叉回环。');
      continue;
    }
    for (const mid of members) seenMembers.set(mid, le);
  }
  return errors;
}

/**
 * Detect structural warnings on a canvas plan (all three classes are rendered
 * dashed on the canvas and skipped at run time):
 *   1. Unreachable nodes.
 *   2. Solo chained Lead nodes with zero subagent upstream and blank role.
 *   3. Dangling dead-end subagent nodes with zero outgoing edges.
 *   4. Invalid/crossing loop edges or loop conditions with no forward exit.
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
    warnings.push('以下 Lead 节点未连入子代理且未填写分工（role），运行时不生效：'
      + soloList.map((n) => (n.label || n.id) + '(' + n.id + ')').join('、'));
  }
  const deadList = list.filter((n) => deadEnds.has(n.id));
  if (deadList.length) {
    warnings.push('以下子代理节点没有出边，产出未连入下游或终审 Lead，运行时不生效：'
      + deadList.map((n) => (n.label || n.id) + '(' + n.id + ')').join('、'));
  }
  for (const err of validateLoopEdges(list, linkList)) warnings.push(err);
  // Warn if a non-exit node inside a loop has a forward edge leaking outside the loop
  // (that outside branch starts on round 1 and will not re-run on retry rounds).
  const fwdLinks = forwardEdgesOf(linkList);
  const byId = new Map(list.map((n) => [n.id, n]));
  for (const le of linkList) {
    if (!isLoopEdge(le)) continue;
    const members = loopMemberIds(list, linkList, le);
    if (!members.size) continue;
    const leaked = [];
    for (const e of fwdLinks) {
      if (e.from !== le.from && members.has(e.from) && !members.has(e.to)) {
        const src = byId.get(e.from);
        const dst = byId.get(e.to);
        leaked.push(((src && src.label) || e.from) + ' → ' + ((dst && dst.label) || e.to));
      }
    }
    if (leaked.length) {
      warnings.push('回环内部节点存在绕过条件裁判的旁路连线（' + leaked.join('、') + '），回环重试时这些环外节点不会重跑。');
    }
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
      preset: (id === 'lead' ? '' : (kind === 'condition' ? 'minimal' : String(raw.preset || ''))),
      structured: Boolean(raw.structured),
      keepSession: Boolean(raw.keepSession),
      fallbackModel: String(raw.fallbackModel || ''),
      fallbackProvider: String(raw.fallbackProvider || ''),
      x: 0,
      y: 0,
    };
    const normRefs = normalizeRefs(raw.refs);
    if (normRefs) nodeObj.refs = normRefs;
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
    if (raw.loop === true) {
      edgeObj.loop = true;
      edgeObj.maxIterations = normalizeMaxIterations(raw.maxIterations);
    }
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
  const topRefs = normalizeRefs(args && args.refs);
  if (topRefs && !entry.refs) entry.refs = topRefs;

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

  // Layout: depth of the longest path from the entry (ignoring controlled loop back-edges).
  const depth = new Map(nodes.map((n) => [n.id, n.id === 'lead' ? 0 : 1]));
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const e of forwardEdgesOf(edges)) {
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
      if (existing.kind === 'condition') existing.preset = 'minimal';
      if (patch.branches !== undefined) {
        const nb = normalizeBranches(patch.branches);
        if (nb) existing.branches = nb;
        else delete existing.branches;
      }
      if (patch.multiMatch !== undefined) {
        if (patch.multiMatch) existing.multiMatch = true;
        else delete existing.multiMatch;
      }
      if (patch.refs !== undefined) {
        const nr = normalizeRefs(patch.refs);
        if (nr) existing.refs = nr;
        else delete existing.refs;
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
      created.preset = (created.kind === 'condition' || created.preset === 'minimal') ? 'minimal' : 'standard';
      if (created.kind === 'condition' && patch.branches !== undefined) {
        const nb = normalizeBranches(patch.branches);
        if (nb) created.branches = nb;
      }
      if (created.kind === 'condition' && patch.multiMatch === true) {
        created.multiMatch = true;
      }
      if (patch.refs !== undefined) {
        const nr = normalizeRefs(patch.refs);
        if (nr) created.refs = nr;
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
    const existingEdge = edges.find((e) => e.from === edge.from && e.to === edge.to && e.type === type && normalizeBranch(e.branch) === branch);
    if (existingEdge) {
      if (edge.loop === true) {
        existingEdge.loop = true;
        existingEdge.maxIterations = normalizeMaxIterations(edge.maxIterations !== undefined ? edge.maxIterations : existingEdge.maxIterations);
      } else if (edge.loop === false) {
        delete existingEdge.loop;
        delete existingEdge.maxIterations;
      }
      continue;
    }
    const nextEdge = { from: edge.from, to: edge.to, type };
    if (branch) nextEdge.branch = branch;
    if (edge.loop === true) {
      nextEdge.loop = true;
      nextEdge.maxIterations = normalizeMaxIterations(edge.maxIterations);
    }
    edges.push(nextEdge);
  }
  const structuredSources = new Set(edges.filter((e) => e.type === 'structured').map((e) => e.from));
  for (const node of keptNodes) {
    node.structured = structuredSources.has(node.id);
  }
  const taskPatched = typeof (args && args.task) === 'string';
  const nextTask = taskPatched ? args.task : String(plan.task || '');
  const refsPatched = args && args.refs !== undefined;
  const nextRefs = refsPatched ? normalizeRefs(args.refs) : normalizeRefs(plan.refs);
  const nextPlan = { ...plan, task: nextTask, nodes: keptNodes, edges };
  if (nextRefs) nextPlan.refs = nextRefs;
  else delete nextPlan.refs;
  return {
    plan: nextPlan,
    touched,
    taskPatched,
    refsPatched,
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
function resolveSessionsService(scope) {
  try {
    return (scope && scope.sessions) || (scope && typeof scope.get === 'function' ? scope.get('sessions') : null);
  } catch (_e) {
    return null;
  }
}

function publishCanvas(scope, sessionId, canvas) {
  try {
    const sessionsSvc = resolveSessionsService(scope);
    const live = sessionsSvc && typeof sessionsSvc.get === 'function' ? sessionsSvc.get(sessionId) : null;
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

/**
 * Build a zero-token structured run summary snapshot from in-memory executor state.
 * Published inside `.run.json` for the sidebar UI (never injected into model prompts).
 */
function buildRunSummarySnapshot(st, opts) {
  if (!st || typeof st !== 'object') return null;
  const o = opts || {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const status = typeof o.status === 'string' && o.status ? o.status : 'running';
  const waitingLead = o.waitingLead || st.waitingLead || null;
  const haltedReason = typeof o.haltedReason === 'string' && o.haltedReason
    ? o.haltedReason
    : (st.haltedReason || '');
  const isTerminal = status === 'done' || status === 'halted';
  const startedAt = typeof st.startedAt === 'number' ? st.startedAt : now;
  const endedAt = isTerminal ? (typeof st.endedAt === 'number' ? st.endedAt : now) : null;
  const nodeStatsMap = st.nodeStats && typeof st.nodeStats === 'object' ? st.nodeStats : {};
  const prunedSet = st.pruned instanceof Set ? st.pruned : new Set(Array.isArray(st.pruned) ? st.pruned : []);
  const decisions = st.decisions && typeof st.decisions === 'object' ? st.decisions : {};
  const failedMap = st.failed && typeof st.failed === 'object' ? st.failed : {};
  const emptyMap = st.emptyOutputs && typeof st.emptyOutputs === 'object' ? st.emptyOutputs : {};
  const nodeMeta = st.nodeMeta && typeof st.nodeMeta === 'object' ? st.nodeMeta : {};
  const orderIds = Array.isArray(st.orderIds) && st.orderIds.length
    ? st.orderIds
    : Object.keys(nodeStatsMap);

  const nodes = [];
  for (const id of orderIds) {
    const meta = nodeMeta[id] || {};
    const stat = nodeStatsMap[id] || null;
    const dec = decisions[id] || null;
    const fail = failedMap[id] || null;
    const isPruned = prunedSet.has(id);
    const isWaiting = Boolean(status === 'need-lead' && waitingLead && waitingLead.id === id);

    let entryStatus = 'pending';
    let durationMs = stat && typeof stat.durationMs === 'number' ? stat.durationMs : 0;
    let entryStartedAt = stat && typeof stat.startedAt === 'number' ? stat.startedAt : null;
    let entryEndedAt = stat && typeof stat.endedAt === 'number' ? stat.endedAt : null;

    if (isPruned && (!stat || stat.status === 'pending' || stat.status === 'pruned')) {
      entryStatus = 'pruned';
    } else if (isWaiting) {
      entryStatus = 'waiting';
    } else if (stat && stat.status) {
      entryStatus = stat.status;
      if (status === 'halted' && (entryStatus === 'running' || entryStatus === 'waiting')) {
        entryStatus = 'halted';
        if (entryStartedAt && !entryEndedAt) {
          durationMs += Math.max(0, now - entryStartedAt);
          entryEndedAt = now;
        }
      }
    } else if (fail) {
      entryStatus = 'failed';
    } else if (emptyMap[id]) {
      entryStatus = 'empty';
    }

    let reason = (stat && typeof stat.reason === 'string' ? stat.reason : '') || (fail && fail.reason) || '';
    if (!reason && dec) {
      const matched = Array.isArray(dec.branchLabels) && dec.branchLabels.length
        ? dec.branchLabels.join(', ')
        : (dec.branchLabel || dec.branch || '');
      const decReason = typeof dec.reason === 'string' ? dec.reason.trim() : '';
      reason = matched ? (decReason ? matched + ' — ' + decReason : matched) : decReason;
    }
    if (reason.length > 160) reason = reason.slice(0, 159) + '…';

    nodes.push({
      id,
      label: (stat && stat.label) || meta.label || (st.labels && st.labels[id]) || id,
      kind: (stat && stat.kind) || meta.kind || 'agent',
      status: entryStatus,
      startedAt: entryStartedAt,
      endedAt: entryEndedAt,
      durationMs,
      runs: stat && typeof stat.runs === 'number' ? stat.runs : 0,
      model: (stat && stat.model) || meta.model || '',
      fallbackUsed: Boolean(stat && stat.fallbackUsed),
      sessionContinued: Boolean(stat && stat.sessionContinued),
      childId: (stat && stat.childId) || '',
      reason,
    });
  }

  const loopMeta = Array.isArray(st.loopMeta) ? st.loopMeta : [];
  const loopCounts = st.loopCounts && typeof st.loopCounts === 'object' ? st.loopCounts : {};
  const loopHistory = st.loopHistory && typeof st.loopHistory === 'object' ? st.loopHistory : {};
  const exhaustedKeys = new Set(Array.isArray(st.loopExhausted) ? st.loopExhausted.map((x) => x && x.edgeKey).filter(Boolean) : []);
  const loops = [];
  for (const lm of loopMeta) {
    const used = Number(loopCounts[lm.key]) || 0;
    const rawRounds = Array.isArray(loopHistory[lm.key]) ? loopHistory[lm.key] : [];
    const exhausted = exhaustedKeys.has(lm.key);
    if (used === 0 && rawRounds.length === 0 && !exhausted) continue;
    loops.push({
      fromLabel: lm.fromLabel,
      toLabel: lm.toLabel,
      used,
      max: lm.max,
      exhausted,
      rounds: rawRounds.map((r) => ({
        round: r.round,
        reason: typeof r.reason === 'string' && r.reason.length > 140 ? r.reason.slice(0, 139) + '…' : (r.reason || ''),
      })),
    });
  }

  return {
    status,
    startedAt,
    endedAt,
    haltedReason,
    maxParallel: typeof st.maxParallel === 'number' ? st.maxParallel : 4,
    totalLoops: typeof st.totalLoops === 'number' ? st.totalLoops : 0,
    reused: Array.isArray(st.reusedIds) ? st.reusedIds.slice() : [],
    nodes,
    loops,
  };
}

/**
 * Publish live run-state telemetry (condition decisions, pruned nodes, blocked edges,
 * waitingLead, and zero-token run summary) to `.dsh/canvas/<sessionId>.run.json` so
 * the sidebar canvas can visualize branch routing and execution metrics without touching
 * the canvas definition file or injecting anything into model prompts.
 */
function publishRunState(scope, sessionId, runState) {
  try {
    if (!sessionId) return false;
    const sessionsSvc = resolveSessionsService(scope);
    const live = sessionsSvc && typeof sessionsSvc.get === 'function' ? sessionsSvc.get(sessionId) : null;
    const root = live && live.header && live.header.cwd;
    if (!root) return false;
    const dir = join(root, '.dsh', 'canvas');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, sessionId + '.run.json'), JSON.stringify({
      ...(runState || {}),
      at: Date.now(),
    }), 'utf8');
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * Force-stop any running or paused (waitingLead) workflow for `sessionId`.
 * Uses DSH 0.2.2 native APIs:
 *   - `scope.subagents.interrupt(childId, { kind: 'user' })` for each live child
 *   - `scope.subagents.drainDescendants([rootAgent])` to tear down the full subtree
 *   - `rootAgent.cancel({ kind: 'user' }, { keepInbox: true })` when a turn is active
 * Also aborts our local `AbortController`, preserves partial progress in `lastRunBySession`,
 * clears `runBySession` (`waitingLead`), and writes `halted` / `idle` to `.run.json`.
 */
function abortSessionRun(scope, sessionId, rootAgent, opts) {
  const sid = sessionId !== undefined && sessionId !== null ? String(sessionId) : '';
  if (!sid) return { stopped: false, wasRunning: false, wasWaiting: false };
  const allowCancelRoot = !(opts && opts.cancelRootTurn === false);

  const active = activeRunBySession.get(sid);
  const wasRunning = Boolean(active);
  const childIds = active && active.childIds ? Array.from(active.childIds) : [];
  if (active) {
    try { active.ctrl.abort('user-stop'); } catch (_e) { /* ignore */ }
    activeRunBySession.delete(sid);
  }

  // Interrupt every tracked live child immediately via DSH's native subagents.interrupt API.
  let subagents = null;
  try {
    subagents = (scope && scope.subagents) || (scope && typeof scope.get === 'function' ? scope.get('subagents') : null);
  } catch (_e) { subagents = null; }
  if (subagents && typeof subagents.interrupt === 'function') {
    for (const cid of childIds) {
      try { subagents.interrupt(cid, { kind: 'user' }); } catch (_e) { /* best-effort */ }
    }
  }

  // Resolve the exact root Agent (from command invocation or `scope.agents.get(sid)`)
  // to drain the entire descendant subagent tree and cancel any active root turn.
  let targetAgent = rootAgent || null;
  if (!targetAgent) {
    let agentsSvc = null;
    try {
      agentsSvc = (scope && scope.agents) || (scope && typeof scope.get === 'function' ? scope.get('agents') : null);
    } catch (_e) { agentsSvc = null; }
    if (agentsSvc && typeof agentsSvc.get === 'function') {
      try { targetAgent = agentsSvc.get(sid) || null; } catch (_e) { targetAgent = null; }
    }
  }
  if (targetAgent) {
    if (subagents && typeof subagents.drainDescendants === 'function') {
      try {
        // Fire-and-forget teardown so `/canvas-stop` returns immediately to the UI even if a remote provider stalls.
        Promise.resolve(subagents.drainDescendants([targetAgent])).catch(() => {});
      } catch (_e) { /* best-effort */ }
    }
    if (allowCancelRoot && (wasRunning || targetAgent.running) && typeof targetAgent.cancel === 'function') {
      try { targetAgent.cancel({ kind: 'user' }, { keepInbox: true }); } catch (_e) { /* best-effort */ }
    }
  }

  const st = runBySession.get(sid);
  const wasWaiting = Boolean(st && st.waitingLead);
  if (st) {
    const haltNow = Date.now();
    st.endedAt = haltNow;
    st.haltedReason = wasWaiting ? '用户结束了等待拍板状态' : '用户主动终止';
    if (st.done && st.done.size > 0) {
      lastRunBySession.set(sid, {
        sig: st.sig,
        done: new Set(st.done),
        results: { ...(st.results || {}) },
        labels: { ...(st.labels || {}) },
        failed: { ...(st.failed || {}) },
        emptyOutputs: { ...(st.emptyOutputs || {}) },
        blockedEdges: new Set(st.blockedEdges || []),
        pruned: new Set(st.pruned || []),
        decisions: { ...(st.decisions || {}) },
        fallbackLinks: Array.isArray(st.fallbackLinks) ? st.fallbackLinks.map((fl) => ({ ...fl })) : [],
        nodeStats: st.nodeStats ? Object.fromEntries(Object.entries(st.nodeStats).map(([k, v]) => [k, { ...v }])) : {},
        halted: true,
      });
    }
    const summary = buildRunSummarySnapshot(st, {
      status: 'halted',
      waitingLead: null,
      haltedReason: st.haltedReason,
      now: haltNow,
    });
    runBySession.delete(sid);
    publishRunState(scope, sid, {
      status: 'halted',
      done: Array.from(st.done || []),
      decisions: { ...(st.decisions || {}) },
      pruned: Array.from(st.pruned || []),
      blockedEdges: Array.from(st.blockedEdges || []),
      loopCounts: {},
      nodeAttempts: { ...(st.nodeAttempts || {}) },
      waitingLead: null,
      summary,
    });
    saveStore();
  } else {
    // Even if in-memory state was already gone (e.g. after restart), overwrite any stale `.run.json`
    // so a leftover `need-lead` file can never trap the sidebar UI.
    publishRunState(scope, sid, {
      status: wasRunning ? 'halted' : 'idle',
      done: [],
      decisions: {},
      pruned: [],
      blockedEdges: [],
      loopCounts: {},
      nodeAttempts: {},
      waitingLead: null,
      summary: null,
    });
  }
  return { stopped: true, wasRunning, wasWaiting };
}

async function runPlan(scope, args, exec) {
  const agent = exec && exec.agent;
  const sid = agent && agent.id !== undefined ? String(agent.id) : '';
  if (args && args.cancel === true) {
    // Pass `cancelRootTurn: false` because this tool call runs inside the model's current turn;
    // cancelling the root turn here would cut off the model's own cancellation confirmation reply.
    const res = abortSessionRun(scope, sid, agent, { cancelRootTurn: false });
    return {
      status: 'cancelled',
      wasRunning: res.wasRunning,
      wasWaiting: res.wasWaiting,
      hint: res.wasWaiting
        ? '已终止暂停中的工作流并解除等待拍板状态。'
        : '已终止当前工作流执行。',
    };
  }
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
      preset: (normalizeKind(n.kind) === 'condition' || n.preset === 'minimal') ? 'minimal' : 'standard',
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
    const nr = normalizeRefs(n.refs);
    if (nr) item.refs = nr;
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
    if (e.loop === true) {
      out.loop = true;
      out.maxIterations = normalizeMaxIterations(e.maxIterations);
    }
    return out;
  }) : [];
  const planRefs = normalizeRefs(plan.refs);
  const out = {
    hasCanvas: true,
    enabled: Boolean(payload.enabled),
    task: String(plan.task || ''),
    nodes,
    edges,
    warnings: analyzeCanvasWarnings(nodes, edges),
    paused: Boolean(sid && runBySession.get(sid) && runBySession.get(sid).waitingLead),
  };
  if (planRefs) out.refs = planRefs;
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
    const loopHint = wl.loopFeedback
      ? ('（↺ 第 ' + wl.loopFeedback.retry + '/' + wl.loopFeedback.max + ' 次回环修正，打回理由：' + (wl.loopFeedback.reason || '未达预期') + '）')
      : '';
    return [
      '[Workflow Canvas Active — Paused at Lead Step]',
      '当前会话的工作流画布正暂停在中间 Lead 节点「' + wl.label + '」（分工：' + (wl.role || wl.label) + '）' + loopHint + '。',
      '- 若用户的当前消息是在拍板、确认、补充决策或要求继续：请整理决策结论并直接调用 `canvas_workflow({ leadResult: "..." })` 恢复下游节点运行。',
      '- 若用户要求取消、结束或终止当前工作流：直接调用 `canvas_workflow({ cancel: true })` 解除暂停状态。',
      '- 若用户要求放弃当前进度从头重跑：调用 `canvas_workflow({ reset: true })`。',
      '- 若用户要求修改画布结构、分工、参考清单、分支或回环：先 `canvas_inspect` 再用 `canvas_patch`。',
    ].join('\n');
  }

  const preview = nodes
    .slice(0, 8)
    .map((n) => (n.kind === 'lead' ? '〔Lead〕' : (n.kind === 'condition' ? '〔条件〕' : '')) + (n.label || n.id))
    .join(' → ') + (nodes.length > 8 ? ' …' : '');
  const hasTask = Boolean(String((plan && plan.task) || '').trim());
  const loopCount = (plan && Array.isArray(plan.edges)) ? plan.edges.filter((e) => isLoopEdge(e)).length : 0;
  const globalRefs = normalizeRefs(plan && plan.refs) || [];
  const prefix = String(sid) + '::';
  const hasMemory = nodes.some((n) => n.keepSession && (liveChild.has(prefix + n.id) || childByNode.has(prefix + n.id)));
  const metaParts = [
    '共 ' + nodes.length + ' 个执行节点：' + preview,
    '入口总任务：' + (hasTask ? '已填写' : '未填写'),
  ];
  if (loopCount > 0) metaParts.push('含 ' + loopCount + ' 条受控回环（引擎自动按条件带反馈重试并在超限时熔断交 Lead，无需你手动循环调用）');
  if (globalRefs.length > 0) metaParts.push('全局参考 ×' + globalRefs.length);
  const lines = [
    '[Workflow Canvas Active]',
    '当前会话的右侧工作流画布处于「● 已启用」状态（' + metaParts.join('；') + '）。',
    '- 若用户发出任务请求、布置工作或说「开始 / 执行 / 跑一次」：请直接调用 `canvas_workflow` 按画布编排执行（'
      + (hasTask ? '可直接沿用入口总任务；若用户给出了新任务则通过 task 参数传入' : '请将用户的任务内容作为 task 参数传入')
      + '），不要绕过画布直接自己完成。',
    '- 若用户在讨论或要求修改画布结构、模型、分工、参考清单、条件分支、回环或连线：请先 `canvas_inspect` 再用 `canvas_patch` 就地修改，不要直接运行。',
    '- 仅当用户明确只是闲聊、问无关问题或要求先停用画布时，才无需调用 `canvas_workflow`。',
  ];
  if (hasMemory) {
    lines.push('- 本会话已有开启「记忆」节点的历史子代理会话：若用户说「再跑一次 / 换个任务重跑」，请先简短询问用户是保留上次记忆继续（reset: true）还是清空记忆全新开跑（reset: true, clearMemory: true）。');
  }
  const stdCount = nodes.filter((n) => n.kind !== 'lead' && n.kind !== 'condition' && n.preset !== 'minimal').length;
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
  if (opts.cancel === true) {
    const res = abortSessionRun(scope, sid, agent, { cancelRootTurn: false });
    return {
      status: 'cancelled',
      wasRunning: res.wasRunning,
      wasWaiting: res.wasWaiting,
      hint: res.wasWaiting
        ? '已终止暂停中的工作流并解除等待拍板状态。'
        : '已终止当前工作流执行。',
    };
  }
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
  const loopErrors = validateLoopEdges(plan.nodes, plan.edges);
  if (loopErrors.length) return { error: '回环配置无效：' + loopErrors[0] };

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
  const orderIds = runnable.map((n) => n.id);
  const nodeMeta = Object.fromEntries(runnable.map((n) => [n.id, {
    label: n.label || n.id,
    kind: n.kind || 'agent',
    model: formatModelLabel(n.provider, n.model),
  }]));
  const loopMeta = (plan.edges || [])
    .filter((e) => isLoopEdge(e))
    .map((e) => ({
      key: edgeKey(e),
      fromLabel: labelOf.get(e.from) || e.from,
      toLabel: labelOf.get(e.to) || e.to,
      max: normalizeMaxIterations(e.maxIterations),
    }));
  const rawMaxParallel = opts.maxParallel !== undefined ? opts.maxParallel : plan.maxParallel;
  const MAX_PARALLEL = Number.isFinite(Number(rawMaxParallel))
    ? Math.max(1, Math.min(8, Math.floor(Number(rawMaxParallel))))
    : 4;
  const sig = JSON.stringify(plan);
  let state = runBySession.get(sid);
  const wantRetryFailed = opts.retryFailed === true;
  const rawFromNodes = Array.isArray(opts.fromNodes) ? opts.fromNodes.filter((x) => typeof x === 'string' && x.trim()) : [];
  const wantPartial = wantRetryFailed || rawFromNodes.length > 0;
  let reused = [];
  let reusedIds = [];

  if (wantPartial && sid) {
    const base = state || lastRunBySession.get(sid);
    if (base) {
      const prevStats = base.nodeStats && typeof base.nodeStats === 'object' ? base.nodeStats : {};
      const carriedStats = {};
      for (const [k, v] of Object.entries(prevStats)) {
        if (byId.has(k) && v && typeof v === 'object') carriedStats[k] = { ...v };
      }
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
        loopCounts: {},
        totalLoops: 0,
        loopHistory: {},
        loopFeedback: {},
        nodeAttempts: {},
        loopWarmChild: {},
        loopExhausted: [],
        waitingLead: null,
        startedAt: Date.now(),
        endedAt: null,
        haltedReason: '',
        maxParallel: MAX_PARALLEL,
        orderIds,
        nodeMeta,
        loopMeta,
        nodeStats: carriedStats,
        reusedIds: [],
      };
      // Build forward adjacency to invalidate seed nodes and all their downstream dependents.
      const fwd = new Map();
      for (const e of forwardEdgesOf(plan.edges || [])) {
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
        delete state.nodeStats[id];
      }
      for (const e of plan.edges || []) {
        if (e && invalid.has(e.from)) state.blockedEdges.delete(edgeKey(e));
      }
      state.fallbackLinks = state.fallbackLinks.filter((fl) => !invalid.has(fl.from) && !invalid.has(fl.to));
      reusedIds = Array.from(state.done).filter((id) => !state.pruned.has(id));
      state.reusedIds = reusedIds;
      for (const id of reusedIds) {
        const meta = nodeMeta[id] || {};
        state.nodeStats[id] = {
          ...(state.nodeStats[id] || {
            id,
            label: meta.label || id,
            kind: meta.kind || 'agent',
            startedAt: null,
            endedAt: null,
            durationMs: 0,
            runs: 1,
            model: meta.model || '',
            fallbackUsed: false,
            sessionContinued: false,
            childId: '',
            reason: '',
          }),
          status: 'reused',
        };
      }
      reused = reusedIds.map((id) => labelOf.get(id) || id);
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
      loopCounts: {},
      totalLoops: 0,
      loopHistory: {},
      loopFeedback: {},
      nodeAttempts: {},
      loopWarmChild: {},
      loopExhausted: [],
      waitingLead: null,
      startedAt: Date.now(),
      endedAt: null,
      haltedReason: '',
      maxParallel: MAX_PARALLEL,
      orderIds,
      nodeMeta,
      loopMeta,
      nodeStats: {},
      reusedIds: [],
    };
    runBySession.set(sid, state);
  }
  if (!state.emptyOutputs) state.emptyOutputs = {};
  if (!state.blockedEdges) state.blockedEdges = new Set();
  if (!state.pruned) state.pruned = new Set();
  if (!state.decisions) state.decisions = {};
  if (!state.fallbackLinks) state.fallbackLinks = [];
  if (!state.loopCounts) state.loopCounts = {};
  if (typeof state.totalLoops !== 'number') state.totalLoops = 0;
  if (!state.loopHistory) state.loopHistory = {};
  if (!state.loopFeedback) state.loopFeedback = {};
  if (!state.nodeAttempts) state.nodeAttempts = {};
  if (!state.loopWarmChild) state.loopWarmChild = {};
  if (!state.loopExhausted) state.loopExhausted = [];
  if (typeof state.startedAt !== 'number') state.startedAt = Date.now();
  if (!state.nodeStats) state.nodeStats = {};
  state.maxParallel = MAX_PARALLEL;
  state.orderIds = orderIds;
  state.nodeMeta = nodeMeta;
  state.loopMeta = loopMeta;

  const emitRunState = (status, waitingLead, reasonOverride) => {
    if (!sid) return;
    const loopCounts = {};
    for (const e of plan.edges || []) {
      if (!isLoopEdge(e)) continue;
      const k = edgeKey(e);
      const entry = { count: state.loopCounts[k] || 0, max: normalizeMaxIterations(e.maxIterations) };
      loopCounts[k] = entry;
      if (e.id) loopCounts[e.id] = entry;
    }
    const summary = buildRunSummarySnapshot(state, {
      status,
      waitingLead,
      haltedReason: reasonOverride || state.haltedReason || '',
    });
    publishRunState(scope, sid, {
      status,
      done: Array.from(state.done || []),
      decisions: { ...state.decisions },
      pruned: Array.from(state.pruned || []),
      blockedEdges: Array.from(state.blockedEdges || []),
      loopCounts,
      nodeAttempts: { ...state.nodeAttempts },
      waitingLead: waitingLead ? { id: waitingLead.id, label: waitingLead.label } : null,
      summary,
    });
  };
  emitRunState('running', null);

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
      nodeStats: Object.fromEntries(Object.entries(state.nodeStats || {}).map(([k, v]) => [k, { ...v }])),
      halted: Boolean(haltedFlag),
    });
  };
  const depsOf = (node) => {
    const out = new Set();
    for (const e of forwardEdgesOf(plan.edges || [])) {
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
    for (const e of forwardEdgesOf(plan.edges || [])) {
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
    for (const e of forwardEdgesOf(plan.edges || [])) {
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
    // Re-evaluate reachability from entry Lead over non-blocked forward edges so diamond
    // convergence nodes stay active, while side-channel edges from ancestors of a
    // condition node (e.g. A --session-ref--> N) cannot bypass a blocked branch gate.
    const fwdEdges = forwardEdgesOf(plan.edges || []);
    const condAncestors = new Map();
    const blockedSources = new Map();
    for (const e of fwdEdges) {
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
      for (const e of fwdEdges) {
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
            for (const e of fwdEdges) {
              if (e && e.from === n.id && e.to) addGates(e.to, gates);
            }
          }
        }
      }
      if (!addedAny) break;
    }
  };

  let leadResult = typeof opts.leadResult === 'string' ? opts.leadResult : undefined;
  // Event-driven concurrency pool: as soon as any node finishes, newly unblocked
  // downstream agents start immediately instead of waiting for slower siblings.
  const inFlight = new Map();

  const runCtrl = new AbortController();
  const runSignal = runCtrl.signal;
  const activeRec = { ctrl: runCtrl, childIds: new Set() };
  const parentSignal = exec && exec.signal;
  const onParentAbort = () => {
    try { runCtrl.abort('parent-abort'); } catch (_e) { /* ignore */ }
    // Also interrupt every already-running child via DSH's native subagents.interrupt API,
    // since startActivation({ signal }) only aborts startup, not post-start execution.
    try {
      const subagents = (scope && scope.subagents) || (scope && typeof scope.get === 'function' ? scope.get('subagents') : null);
      if (subagents && typeof subagents.interrupt === 'function') {
        for (const cid of activeRec.childIds) {
          try { subagents.interrupt(cid, { kind: 'user' }); } catch (_e) { /* best-effort */ }
        }
      }
    } catch (_e) { /* best-effort */ }
  };
  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort();
    else if (typeof parentSignal.addEventListener === 'function') {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }
  if (sid) activeRunBySession.set(sid, activeRec);

  const isAborted = () => Boolean(runSignal.aborted || (parentSignal && parentSignal.aborted));
  // Raced alongside `inFlight` so user cancellation unblocks immediately even if a child activation hangs.
  const abortPromise = new Promise((resolve) => {
    if (isAborted()) { resolve({ __aborted: true }); return; }
    runSignal.addEventListener('abort', () => resolve({ __aborted: true }), { once: true });
  });
  const finishAborted = () => {
    state.endedAt = Date.now();
    state.haltedReason = '工作流执行已取消';
    snapshotLastRun(true);
    emitRunState('halted', null, state.haltedReason);
    if (sid) runBySession.delete(sid);
    saveStore();
    return {
      status: 'halted',
      error: '工作流执行已取消。',
      results: state.results,
      labels: state.labels,
      failed: Object.values(state.failed),
      emptyOutputs: Object.values(state.emptyOutputs),
      decisions: Object.values(state.decisions),
      branchSkipped: branchSkippedList(),
      ...(state.loopExhausted.length ? { loopExhausted: state.loopExhausted } : {}),
      reused,
      skipped,
    };
  };
  const permBlocked = [];
  let activationFailCount = 0;
  let haltedReason = '';

  const launchReadyAgents = () => {
    if (isAborted() || haltedReason || inFlight.size >= MAX_PARALLEL) return;
    const candidates = runnable.filter((n) => n.kind !== 'lead'
      && !state.done.has(n.id)
      && !inFlight.has(n.id)
      && depsOf(n).every((id) => state.done.has(id)));
    let launched = 0;
    for (const node of candidates) {
      if (isAborted() || haltedReason || inFlight.size >= MAX_PARALLEL) break;
      const fb = state.loopFeedback[node.id] || null;
      const warmChildId = (fb && state.loopWarmChild[node.id]) ? state.loopWarmChild[node.id] : '';
      const loopCtx = fb ? { feedback: fb, warmChildId } : undefined;
      if (fb) delete state.loopFeedback[node.id];
      const launchAt = Date.now();
      const prevStat = state.nodeStats[node.id];
      state.nodeStats[node.id] = {
        id: node.id,
        label: node.label || node.id,
        kind: node.kind || 'agent',
        status: 'running',
        startedAt: launchAt,
        endedAt: null,
        durationMs: prevStat && typeof prevStat.durationMs === 'number' ? prevStat.durationMs : 0,
        runs: (prevStat && typeof prevStat.runs === 'number' ? prevStat.runs : 0) + 1,
        model: formatModelLabel(node.provider, node.model) || (prevStat && prevStat.model) || '',
        fallbackUsed: Boolean(prevStat && prevStat.fallbackUsed),
        sessionContinued: Boolean(prevStat && prevStat.sessionContinued),
        childId: (prevStat && prevStat.childId) || '',
        reason: '',
      };
      const promise = spawnNode(scope, plan, node, state.results, agent, runSignal, sid, state.failed, state.pruned, loopCtx)
        .then(
          (outcome) => ({ node, outcome, startedAt: launchAt }),
          (err) => ({ node, startedAt: launchAt, outcome: { ok: false, reason: 'run-failed', text: '运行失败：' + String((err && err.message) || err) } }),
        );
      inFlight.set(node.id, promise);
      launched += 1;
    }
    if (launched > 0) emitRunState('running', null);
  };

  try {
  for (;;) {
    if (isAborted()) {
      return finishAborted();
    }
    // On circuit-break halt, stop launching new downstream waves immediately,
    // but let already in-flight siblings settle so no orphan promises or partial
    // results are dropped before returning the halted report.
    if (haltedReason && inFlight.size === 0) {
      state.endedAt = Date.now();
      state.haltedReason = haltedReason;
      snapshotLastRun(true);
      emitRunState('halted', null, haltedReason);
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
        ...(state.loopExhausted.length ? { loopExhausted: state.loopExhausted } : {}),
        reused,
        skipped,
      };
    }
    const remaining = runnable.filter((n) => !state.done.has(n.id));
    if (!remaining.length) {
      state.endedAt = Date.now();
      snapshotLastRun(false);
      emitRunState('done', null);
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
        ...(state.loopExhausted.length ? { loopExhausted: state.loopExhausted } : {}),
        reused,
        skipped,
      };
    }

    launchReadyAgents();

    if (inFlight.size > 0) {
      const raceHit = await Promise.race([...inFlight.values(), abortPromise]);
      if ((raceHit && raceHit.__aborted) || isAborted()) {
        return finishAborted();
      }
      const { node, outcome, startedAt } = raceHit;
      inFlight.delete(node.id);
      const doneAt = Date.now();
      const attemptElapsed = typeof startedAt === 'number' ? Math.max(0, doneAt - startedAt) : 0;
      const prevStat = state.nodeStats[node.id] || {
        id: node.id,
        label: node.label || node.id,
        kind: node.kind || 'agent',
        durationMs: 0,
        runs: 1,
      };
      state.nodeStats[node.id] = {
        ...prevStat,
        label: node.label || node.id,
        kind: node.kind || 'agent',
        status: !outcome.ok ? 'failed' : (outcome.empty ? 'empty' : 'done'),
        endedAt: doneAt,
        durationMs: (prevStat.durationMs || 0) + attemptElapsed,
        model: outcome.modelUsed || prevStat.model || formatModelLabel(node.provider, node.model),
        fallbackUsed: Boolean(prevStat.fallbackUsed || outcome.fallbackUsed),
        sessionContinued: Boolean(prevStat.sessionContinued || outcome.sessionContinued),
        childId: outcome.childId || prevStat.childId || '',
        reason: !outcome.ok
          ? ((outcome.reason || 'unknown') + (outcome.errorDetail ? ' — ' + outcome.errorDetail : ''))
          : '',
      };
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
            emitRunState('running', null);
          } else {
            recomputeBranchPrune();
            emitRunState('running', null);
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
        const outEdges = (plan.edges || []).filter((e) => e && e.from === node.id);
        const matchedEdges = outEdges.filter((e) => {
          const edgeBranch = normalizeBranch(e.branch) || branches[0].id;
          return matchedSet.has(edgeBranch);
        });
        const matchedLoopEdges = matchedEdges.filter((e) => isLoopEdge(e));
        const matchedForwardEdges = matchedEdges.filter((e) => !isLoopEdge(e));

        if (matchedLoopEdges.length > 0) {
          // Loop priority: when a condition matches a controlled loop back-edge,
          // execute the retry reset (if within bounds) instead of advancing forward branches.
          const le = matchedLoopEdges[0];
          const leKey = edgeKey(le);
          const maxIter = normalizeMaxIterations(le.maxIterations);
          const used = state.loopCounts[leKey] || 0;
          const members = loopMemberIds(runnable, plan.edges, le);
          if (!state.loopHistory[leKey]) state.loopHistory[leKey] = [];
          state.loopHistory[leKey].push({
            round: used + 1,
            reason: reason || '未达预期',
            sourceLabel: node.label,
            targetLabel: labelOf.get(le.to) || le.to,
          });
          if (used < maxIter && state.totalLoops < MAX_GLOBAL_LOOPS && members.size > 0) {
            const summaryLines = [];
            for (const mid of members) {
              if (mid === node.id) continue;
              const rawRes = state.results[mid];
              if (typeof rawRes === 'string' && rawRes.trim()) {
                const clipped = rawRes.length > 500 ? rawRes.slice(0, 500) + '…' : rawRes;
                summaryLines.push('[' + (labelOf.get(mid) || mid) + '] ' + clipped);
              }
            }
            const nextRetry = used + 1;
            state.loopCounts[leKey] = nextRetry;
            state.totalLoops += 1;
            for (const mid of members) {
              state.done.delete(mid);
              state.pruned.delete(mid);
              delete state.results[mid];
              delete state.failed[mid];
              delete state.emptyOutputs[mid];
              delete state.decisions[mid];
              state.nodeAttempts[mid] = { retry: nextRetry, max: maxIter };
              // Preserve cumulative durationMs and runs across loop rounds while marking pending for the next launch.
              if (state.nodeStats[mid]) {
                state.nodeStats[mid] = { ...state.nodeStats[mid], status: 'pending', startedAt: null, endedAt: null };
              }
            }
            for (const e of plan.edges || []) {
              if (e && members.has(e.from)) state.blockedEdges.delete(edgeKey(e));
            }
            // Un-prune previously pruned downstream nodes reachable from loop members so
            // an inner condition picking a different branch on a retry round can still run them.
            if (state.pruned.size > 0) {
              const fwdAdj = new Map();
              for (const e of forwardEdgesOf(plan.edges || [])) {
                if (!e || !e.from || !e.to) continue;
                if (!fwdAdj.has(e.from)) fwdAdj.set(e.from, []);
                fwdAdj.get(e.from).push(e.to);
              }
              const reach = new Set(members);
              const rq = Array.from(members);
              for (let i = 0; i < rq.length; i += 1) {
                for (const nx of fwdAdj.get(rq[i]) || []) {
                  if (!reach.has(nx)) { reach.add(nx); rq.push(nx); }
                }
              }
              for (const rid of reach) {
                if (!members.has(rid) && state.pruned.has(rid)) {
                  state.pruned.delete(rid);
                  state.done.delete(rid);
                }
              }
            }
            state.fallbackLinks = state.fallbackLinks.filter((fl) => !members.has(fl.from) && !members.has(fl.to));
            state.loopFeedback[le.to] = {
              retry: nextRetry,
              max: maxIter,
              reason: reason || '未达预期',
              sourceLabel: node.label,
              lastSummary: summaryLines.join('\n'),
            };
            emitRunState('running', null);
            continue;
          }
          // Loop limit reached: stop jumping back and hand off round history to Lead or exit cleanly.
          const hitGlobalCap = used < maxIter && state.totalLoops >= MAX_GLOBAL_LOOPS;
          const hist = state.loopHistory[leKey].slice();
          state.loopExhausted.push({
            edgeKey: leKey,
            fromLabel: node.label,
            toLabel: labelOf.get(le.to) || le.to,
            iterations: used,
            maxIterations: maxIter,
            ...(hitGlobalCap ? { globalLimit: MAX_GLOBAL_LOOPS } : {}),
            history: hist,
          });
          state.decisions[node.id].loopExhausted = true;
          state.results[node.id] += hitGlobalCap
            ? ('（已达全局最大回环上限 ' + MAX_GLOBAL_LOOPS + ' 次，停止回跳）')
            : ('（已达最大回环重试次数 ' + used + '/' + maxIter + '，停止回跳）');
          for (const e of outEdges) {
            const edgeBranch = normalizeBranch(e.branch) || branches[0].id;
            if (isLoopEdge(e) || !matchedSet.has(edgeBranch)) state.blockedEdges.add(edgeKey(e));
          }
          if (matchedForwardEdges.length === 0) {
            const fallbackLead = nearestDownstreamLead(node.id);
            if (fallbackLead) {
              state.fallbackLinks.push({
                from: node.id,
                to: fallbackLead.id,
                label: node.label,
                loopExhausted: true,
                iterations: used,
                maxIterations: maxIter,
                history: hist,
              });
              state.decisions[node.id].fallbackLead = fallbackLead.label;
              state.results[node.id] += '（已汇总历次反馈转交至最近 Lead「' + fallbackLead.label + '」）';
            }
          }
          recomputeBranchPrune();
          emitRunState('running', null);
          continue;
        }

        for (const e of outEdges) {
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
        emitRunState('running', null);
        continue;
      }
      state.results[node.id] = outcome.text;
      if (!outcome.ok) {
        state.failed[node.id] = { id: node.id, label: node.label, reason: outcome.reason || 'unknown' };
        delete state.loopWarmChild[node.id];
        if (outcome.reason === 'activation-failed') activationFailCount += 1;
      } else if (outcome.empty) {
        state.emptyOutputs[node.id] = { id: node.id, label: node.label };
        delete state.loopWarmChild[node.id];
      } else if (outcome.childId) {
        state.loopWarmChild[node.id] = outcome.childId;
      }
      // If a failing node feeds a condition node, let the condition handle failure routing
      // instead of circuit-breaking the whole run prematurely.
      const routesToCondition = forwardEdgesOf(plan.edges || []).some((e) => e && e.from === node.id
        && byId.get(e.to) && byId.get(e.to).kind === 'condition');
      if (!routesToCondition && isPermissionFailure(outcome)) {
        permBlocked.push(node.label || node.id);
        haltedReason = '检测到权限/沙箱受限导致节点失败（' + permBlocked.join('、')
          + '），已熔断停止启动后续节点以防继续消耗额度。请先检查主对话左下角权限模式，放开后重新运行。';
      } else if (!routesToCondition && activationFailCount >= 2 && !haltedReason) {
        haltedReason = '连续 ' + activationFailCount + ' 个子代理启动失败，已熔断停止后续节点以防继续消耗额度。请检查模型配置或主对话权限后重试。';
      }
      state.done.add(node.id);
      emitRunState('running', null);
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
    const exhaustedConds = jumpedEntries.filter((fl) => fl.loopExhausted);
    const unmatchedConds = jumpedEntries.filter((fl) => !fl.failed && !fl.loopExhausted).map((fl) => fl.label || labelOf.get(fl.from) || fl.from);
    const leadFb = state.loopFeedback[leadNode.id] || null;
    const fallbackParts = [];
    if (leadFb) {
      fallbackParts.push('↺ 【第 ' + leadFb.retry + '/' + leadFb.max + ' 次回环修正】下游条件节点「' + (leadFb.sourceLabel || '条件判断') + '」判定未通过，理由：' + (leadFb.reason || '未达预期') + '。请结合最新反馈修正此步骤后再继续。');
    }
    if (exhaustedConds.length) {
      const exLines = exhaustedConds.map((fl) => {
        const rounds = Array.isArray(fl.history)
          ? fl.history.map((h) => '第' + h.round + '轮：' + h.reason).join('；')
          : '';
        return (fl.label || fl.from) + '（已重试 ' + fl.iterations + '/' + fl.maxIterations + ' 次仍未通过' + (rounds ? ' — ' + rounds : '') + '）';
      });
      fallbackParts.push('⚠ 回环达到最大次数上限已熔断：' + exLines.join('；') + '。请由你（Lead）审阅历次失败摘要后决定下一步。');
    }
    if (failedConds.length) {
      fallbackParts.push('⚠ 条件节点（' + failedConds.join('、') + '）自身执行失败，未擅自选择分支，已跳过中间分支直接转交给你处理；也可调用 canvas_workflow({ retryFailed: true }) 复用上游缓存并只重跑该条件节点及其下游。');
    }
    if (unmatchedConds.length) {
      fallbackParts.push('⚠ 条件节点（' + unmatchedConds.join('、') + '）所有分支均未命中，已跳过中间分支直接转交给你处理。');
    }
    const fallbackNotice = fallbackParts.join(' ');
    const mergedLeadRefs = normalizeRefs((normalizeRefs(plan && plan.refs) || []).concat(normalizeRefs(leadNode.refs) || []));
    const hasDownstreamWork = remaining.some((n) => n.id !== leadNode.id);
    if (!hasDownstreamWork && leadResult === undefined) {
      // Terminal Lead: zero downstream nodes remain, so complete the run directly
      // and hand off final review/delivery to the Lead without a redundant extra turn.
      const termNow = Date.now();
      const prevLeadStat = state.nodeStats[leadNode.id];
      state.nodeStats[leadNode.id] = {
        id: leadNode.id,
        label: leadNode.label || leadNode.id,
        kind: 'lead',
        status: 'done',
        startedAt: (prevLeadStat && prevLeadStat.startedAt) || termNow,
        endedAt: termNow,
        durationMs: prevLeadStat && typeof prevLeadStat.durationMs === 'number' ? prevLeadStat.durationMs : 0,
        runs: (prevLeadStat && typeof prevLeadStat.runs === 'number' ? prevLeadStat.runs : 0) + 1,
        model: '',
        fallbackUsed: false,
        sessionContinued: false,
        childId: '',
        reason: '',
      };
      state.endedAt = termNow;
      state.done.add(leadNode.id);
      snapshotLastRun(false);
      emitRunState('done', null);
      if (sid) runBySession.delete(sid);
      saveStore();
      return {
        status: 'done',
        finalLead: {
          label: leadNode.label,
          role: leadNode.role || leadNode.label,
          needs: depsOf(leadNode).map((id) => byId.get(id).label),
          ...(mergedLeadRefs ? { refs: mergedLeadRefs } : {}),
        },
        results: state.results,
        labels: state.labels,
        failed: Object.values(state.failed),
        emptyOutputs: Object.values(state.emptyOutputs),
        decisions: Object.values(state.decisions),
        branchSkipped: branchSkippedList(),
        ...(state.loopExhausted.length ? { loopExhausted: state.loopExhausted } : {}),
        sessions: leadSessions,
        reused,
        skipped,
        hint: (fallbackNotice ? fallbackNotice + ' ' : '')
          + '所有子代理已完成。最后一步由你（Lead 本体）按要求完成终审/汇总后直接向用户交付即可，无需再次调用 canvas_workflow。',
      };
    }
    if (leadResult === undefined) {
      const pauseNow = Date.now();
      const prevLeadStat = state.nodeStats[leadNode.id];
      state.nodeStats[leadNode.id] = {
        id: leadNode.id,
        label: leadNode.label || leadNode.id,
        kind: 'lead',
        status: 'waiting',
        startedAt: pauseNow,
        endedAt: null,
        durationMs: prevLeadStat && typeof prevLeadStat.durationMs === 'number' ? prevLeadStat.durationMs : 0,
        runs: (prevLeadStat && typeof prevLeadStat.runs === 'number' ? prevLeadStat.runs : 0) + 1,
        model: '',
        fallbackUsed: false,
        sessionContinued: false,
        childId: '',
        reason: '',
      };
      const leadFbSummary = leadFb
        ? { retry: leadFb.retry, max: leadFb.max, sourceLabel: leadFb.sourceLabel, reason: leadFb.reason }
        : null;
      state.waitingLead = {
        id: leadNode.id,
        label: leadNode.label,
        role: leadNode.role || leadNode.label,
        ...(leadFbSummary ? { loopFeedback: leadFbSummary } : {}),
      };
      emitRunState('need-lead', state.waitingLead);
      return {
        status: 'need-lead',
        node: {
          label: leadNode.label,
          role: leadNode.role || leadNode.label,
          needs: depsOf(leadNode).map((id) => byId.get(id).label),
          ...(mergedLeadRefs ? { refs: mergedLeadRefs } : {}),
          ...(leadFbSummary ? { loopFeedback: leadFbSummary } : {}),
        },
        results: state.results,
        labels: state.labels,
        failed: Object.values(state.failed),
        emptyOutputs: Object.values(state.emptyOutputs),
        decisions: Object.values(state.decisions),
        branchSkipped: branchSkippedList(),
        ...(state.loopExhausted.length ? { loopExhausted: state.loopExhausted } : {}),
        sessions: leadSessions,
        hint: (fallbackNotice ? fallbackNotice + ' ' : '')
          + '这一步由你（Lead 本体）完成。完成后再次调用本工具，把结果放进 leadResult 继续；若需取消本次流程可传 cancel: true，若需从头重跑可传 reset: true。',
      };
    }
    const resumeNow = Date.now();
    const prevLeadStat = state.nodeStats[leadNode.id];
    const leadWaitMs = prevLeadStat && typeof prevLeadStat.startedAt === 'number'
      ? Math.max(0, resumeNow - prevLeadStat.startedAt)
      : 0;
    state.nodeStats[leadNode.id] = {
      id: leadNode.id,
      label: leadNode.label || leadNode.id,
      kind: 'lead',
      status: 'done',
      startedAt: (prevLeadStat && prevLeadStat.startedAt) || resumeNow,
      endedAt: resumeNow,
      durationMs: (prevLeadStat && typeof prevLeadStat.durationMs === 'number' ? prevLeadStat.durationMs : 0) + leadWaitMs,
      runs: prevLeadStat && typeof prevLeadStat.runs === 'number' ? prevLeadStat.runs : 1,
      model: '',
      fallbackUsed: false,
      sessionContinued: false,
      childId: '',
      reason: '',
    };
    state.waitingLead = null;
    delete state.loopFeedback[leadNode.id];
    state.results[leadNode.id] = leadResult;
    state.labels[leadNode.id] = leadNode.label;
    state.done.add(leadNode.id);
    leadResult = undefined;
    emitRunState('running', null);
  }
  } finally {
    if (parentSignal && typeof parentSignal.removeEventListener === 'function') {
      try { parentSignal.removeEventListener('abort', onParentAbort); } catch (_e) { /* ignore */ }
    }
    if (sid && activeRunBySession.get(sid) === activeRec) {
      activeRunBySession.delete(sid);
    }
  }
}

/** Agent-facing guide, shipped as a skill so any agent can load it on demand. */
const SKILL_NAME = 'workflow-canvas';
const SKILL_DESCRIPTION = 'Workflow canvas (画布 / 工作流 / 编排 / 条件分支 / 回环重试): inspect, draw, edit, run or cancel a node graph of DSH subagents, condition judges, Lead gates, controlled retry loops, reference lists, presets and memory. Load before using canvas_inspect, canvas_generate, canvas_patch or canvas_workflow.';
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
              publishRunState(ctx, id, { status: 'idle', decisions: {}, pruned: [], blockedEdges: [], waitingLead: null });
              saveStore();
              return { kind: 'success', text: 'canvas synced' };
            } catch (error) {
              return { kind: 'error', text: String((error && error.message) || error) };
            }
          },
        }), 'workflow-canvas: sync command');
        scope.effect(() => scope.commands.register({
          name: 'canvas-stop',
          description: 'Stop any running or paused workflow canvas execution for this session.',
          recordInput: false,
          handler: ({ agent }) => {
            try {
              const id = agent && agent.id !== undefined ? String(agent.id) : '';
              if (!id) return { kind: 'error', text: 'no session' };
              abortSessionRun(ctx, id, agent);
              return { kind: 'success', text: 'workflow stopped' };
            } catch (error) {
              return { kind: 'error', text: String((error && error.message) || error) };
            }
          },
        }), 'workflow-canvas: stop command');
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
              refs: { type: 'array', description: 'Optional global reference files, URLs, or rules attached to the entry Lead and injected into all subagents.', items: { type: 'string' } },
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
                    refs: {
                      type: 'array',
                      description: 'Optional reference files, paths, or rules attached to this node and injected into its brief.',
                      items: { type: 'string' },
                    },
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
                    loop: { type: 'boolean', description: 'Optional (condition outgoing edge only): set true to mark a controlled retry back-edge pointing to a strict ancestor node.' },
                    maxIterations: { type: 'integer', minimum: 1, maximum: 10, description: 'Optional (loop edges only): max retry loops before circuit-breaking (1–10, default 3).' },
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
                const entryNode = canvas.nodes.find((n) => n && n.id === 'lead');
                const planObj = {
                  task: String(result.task || (args && args.task) || ''),
                  nodes: withoutEntry(canvas.nodes),
                  edges: canvas.edges,
                };
                const entryRefs = normalizeRefs(entryNode && entryNode.refs);
                if (entryRefs) planObj.refs = entryRefs;
                canvasBySession.set(sid, {
                  enabled: nextEnabled,
                  plan: planObj,
                });
                runBySession.delete(sid);
                lastRunBySession.delete(sid);
                publishRunState(scope, sid, { status: 'idle', decisions: {}, pruned: [], blockedEdges: [], waitingLead: null });
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
              refs: { type: 'array', description: 'Optional: replace global reference files/rules on the entry Lead node.', items: { type: 'string' } },
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
              publishRunState(scope, sid, { status: 'idle', decisions: {}, pruned: [], blockedEdges: [], waitingLead: null });
              saveStore();
              const patchDoc = {
                mode: 'merge',
                nodes: nextPlan.nodes,
                edges: nextPlan.edges,
                removeNodes: patched.removed,
                removeEdges: patched.removeEdges,
              };
              if (patched.taskPatched) patchDoc.task = nextPlan.task;
              if (patched.refsPatched) patchDoc.refs = nextPlan.refs || [];
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
                refs: { type: 'array', items: { type: 'string' } },
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
              if (Array.isArray(v.refs) && v.refs.length) {
                head.push('全局参考：' + v.refs.join('；'));
              }
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
                if (Array.isArray(n.refs) && n.refs.length) flags.push('参考×' + n.refs.length);
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
                + ' --(' + e.type + (e.branch ? ':' + e.branch : '')
                + (e.loop ? ', ↺ loop ×' + normalizeMaxIterations(e.maxIterations) : '')
                + ')--> ' + e.to);
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

    ctx.inject(['tools', 'subagents', 'sessions'], (scope) => {
      try {
        scope.effect(() => scope.tools.register({
          name: 'canvas_workflow',
          description: 'Run, resume, or cancel the workflow canvas of the current session. Executes subagent and condition nodes in parallel waves with automatic branch pruning and controlled retry loops; pauses with status "need-lead" at intermediate Lead nodes (resume via leadResult, or abort via cancel: true). Also supports task override, reset, retryFailed, fromNodes, clearMemory, and maxParallel (1–8). Load the `workflow-canvas` skill first when unsure.',
          parameters: {
            type: 'object',
            properties: {
              leadResult: { type: 'string', description: 'Your own output for the Lead step that was just requested.' },
              task: { type: 'string', description: 'Optional overall task overriding the entry Lead task for this run (useful for reusing a preset).' },
              cancel: { type: 'boolean', description: 'Stop and cancel any active or paused (waitingLead) workflow run cleanly.' },
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
                loopExhausted: { type: 'array' },
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
              if (v.status === 'cancelled') return [{ type: 'text', text: v.hint || '已终止当前工作流执行。' }];
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
              const loopExNote = Array.isArray(v.loopExhausted) && v.loopExhausted.length
                ? '\n\n⚠ 回环达上限熔断：' + v.loopExhausted.map((lx) => (lx.fromLabel || lx.edgeKey) + ' ↺ ' + (lx.toLabel || '') + '（' + lx.iterations + '/' + lx.maxIterations + '）').join('；')
                : '';
              if (v.status === 'need-lead') {
                const n = v.node || {};
                const refsBlock = Array.isArray(n.refs) && n.refs.length
                  ? '\n参考资料 / 约束：\n' + n.refs.map((r) => '- ' + r).join('\n')
                  : '';
                const handed = Array.isArray(v.sessions) ? v.sessions.filter((s) => s && s.childId) : [];
                const handover = handed.length
                  ? '\n\n可用会话（session 连线）：' + handed.map((s) => s.label + ' → ' + s.childId).join('；')
                    + '\n需要追问时，直接给对应子代理发消息即可，它们仍在上游会话里。'
                  : '';
                return [{
                  type: 'text',
                  text: '需要你（Lead）完成「' + n.label + '」：' + n.role
                    + '\n需要用到：' + ((n.needs && n.needs.length) ? n.needs.join('、') : '（无上游）')
                    + refsBlock
                    + decisionList
                    + failedList
                    + emptyList
                    + '\n\n已完成节点的结果：\n' + body
                    + handover
                    + branchSkipNote
                    + loopExNote
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
                  const refsBlock = Array.isArray(fl.refs) && fl.refs.length
                    ? '\n参考资料 / 约束：\n' + fl.refs.map((r) => '- ' + r).join('\n')
                    : '';
                  const handed = Array.isArray(v.sessions) ? v.sessions.filter((s) => s && s.childId) : [];
                  const handover = handed.length
                    ? '\n\n可用会话（session 连线）：' + handed.map((s) => s.label + ' → ' + s.childId).join('；')
                      + '\n如需局部追问或返工，可直接给对应子代理发消息。'
                    : '';
                  return [{
                    type: 'text',
                    text: '所有子代理已完成，现在进入终审 Lead 步骤「' + fl.label + '」：' + fl.role
                      + '\n需要用到：' + ((fl.needs && fl.needs.length) ? fl.needs.join('、') : '（无上游）')
                      + refsBlock
                      + decisionList
                      + failedList
                      + emptyList
                      + '\n\n已完成节点的结果：\n' + body
                      + handover
                      + branchSkipNote
                      + loopExNote
                      + reusedNote
                      + skip
                      + '\n\n' + (v.hint || ''),
                  }];
                }
                return [{ type: 'text', text: '画布执行完成。' + decisionList + failedList + emptyList + loopExNote + '\n\n' + body + branchSkipNote + reusedNote + skip }];
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
  normalizeRefs,
  normalizeMaxIterations,
  loopMemberIds,
  validateLoopEdges,
  parseConditionDecision,
  withoutEntry,
  analyzeCanvasWarnings,
  normalizeCanvas,
  applyPatch,
  inspectPlan,
  sessionIdFromContext,
  buildActiveCanvasContext,
  isPermissionFailure,
  buildRunSummarySnapshot,
  abortSessionRun,
  runPlan,
  executePlan,
};
