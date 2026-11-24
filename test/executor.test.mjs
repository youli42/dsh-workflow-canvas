import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, orderNodes, upstreamOf, downstreamLabels, briefFor, parseConditionDecision, withoutEntry, analyzeCanvasWarnings, normalizeCanvas, applyPatch, inspectPlan, sessionIdFromContext, buildActiveCanvasContext, isPermissionFailure, abortSessionRun, loopMemberIds, validateLoopEdges, executePlan } from '../index.js';

test('withoutEntry strips the entry Lead', () => {
  const nodes = [
    { id: 'lead', kind: 'lead', label: 'Lead' },
    { id: 'n1', kind: 'agent', label: '分类' },
  ];
  assert.deepEqual(withoutEntry(nodes).map((n) => n.id), ['n1']);
});

test('normalizeCanvas adds an entry Lead and a stripped plan keeps it out', () => {
  const canvas = normalizeCanvas({
    task: '总任务',
    nodes: [{ ref: 'c', label: '分类', role: '把请求分类' }],
    edges: [{ from: 'lead', to: 'c' }],
  });
  assert.ok(!canvas.error, String(canvas.error));
  assert.ok(canvas.nodes.find((n) => n.id === 'lead'), 'entry lead exists');
  assert.ok(!withoutEntry(canvas.nodes).some((n) => n.id === 'lead'));
});

test('briefFor injects the task into a first-layer node, not a phantom Lead', () => {
  const plan = {
    task: '总任务原始数据',
    nodes: [{ id: 'n1', kind: 'agent', label: '分类', role: '把请求分类' }],
    edges: [{ from: 'lead', to: 'n1' }],
  };
  const brief = briefFor(plan, plan.nodes[0], {});
  assert.ok(brief.includes('【总任务】总任务原始数据'));
  assert.ok(!brief.includes('（没有结果）'));
  assert.ok(!brief.includes('来自【Lead'));
});

test('briefFor passes upstream results downstream', () => {
  const plan = {
    task: 't',
    nodes: [
      { id: 'n1', kind: 'agent', label: '分类', role: 'a' },
      { id: 'n2', kind: 'agent', label: '执行', role: 'b' },
    ],
    edges: [
      { from: 'lead', to: 'n1' },
      { from: 'n1', to: 'n2', type: 'prompt' },
    ],
  };
  const brief = briefFor(plan, plan.nodes[1], { n1: 'ok:分类#n1' });
  assert.ok(brief.includes('ok:分类#n1'));
  assert.ok(brief.includes('来自【分类】'));
});

test('orderNodes yields a topological order and rejects cycles', () => {
  const dag = {
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
  };
  const order = orderNodes(dag).map((n) => n.id);
  assert.deepEqual(order, ['a', 'b', 'c']);

  const cycle = {
    nodes: [{ id: 'a' }, { id: 'b' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
  };
  assert.equal(orderNodes(cycle), null);
});

test('upstreamOf drops the entry Lead edge', () => {
  const plan = {
    nodes: [{ id: 'n1', kind: 'agent', label: '分类' }],
    edges: [{ from: 'lead', to: 'n1' }],
  };
  assert.equal(upstreamOf(plan, plan.nodes[0]).length, 0);
});

test('downstreamLabels names what a node feeds', () => {
  const plan = {
    nodes: [
      { id: 'n1', kind: 'agent', label: '分类' },
      { id: 'n2', kind: 'agent', label: '执行' },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
  };
  assert.deepEqual(downstreamLabels(plan, plan.nodes[0]), ['执行']);
});

// The case both reviewers flagged: generate then run without a client sync. The
// generate-shaped plan still contains the entry Lead; executePlan must strip it.
test('a generate-shaped plan runs without task loss or a redundant Lead pause', async () => {
  const prompts = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        prompts.push(spec.prompt[0].text);
        return Promise.resolve({
          childId: 'kid-' + spec.label,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };

  const canvas = normalizeCanvas({
    task: '总任务原始数据',
    nodes: [{ ref: 'c', label: '分类', role: '把请求分类' }],
    edges: [{ from: 'lead', to: 'c' }],
  });
  // generate stores the plan WITH the entry lead (the bug we fixed)
  const plan = { task: '总任务原始数据', nodes: canvas.nodes, edges: canvas.edges };

  const exec = { agent: { id: 's1' }, signal: new AbortController().signal };
  const result = await executePlan(scope, plan, {}, exec);

  assert.equal(result.status, 'done');
  assert.ok(prompts[0].includes('【总任务】总任务原始数据'), 'task reaches the first node');
  assert.ok(!prompts[0].includes('（没有结果）'));
  assert.ok(!prompts[0].includes('来自【Lead'));
});

test('applyPatch allows wiring new branches from entry Lead and reports removed edges', () => {
  const base = {
    task: '总任务',
    nodes: [
      { id: 'n1', kind: 'agent', label: '调研A', role: 'A' },
      { id: 'n2', kind: 'agent', label: '汇总', role: '汇总' },
    ],
    edges: [
      { from: 'lead', to: 'n1', type: 'prompt' },
      { from: 'n1', to: 'n2', type: 'prompt' },
    ],
  };

  const patched = applyPatch(base, {
    nodes: [{ id: 'n3', kind: 'agent', label: '调研B', role: 'B' }],
    edges: [
      { from: 'lead', to: 'n3', type: 'prompt' },
      { from: 'n3', to: 'n2', type: 'structured' },
      { from: 'n3', to: 'lead', type: 'prompt' }, // invalid: cannot point into entry lead
    ],
    removeEdges: [{ from: 'n1', to: 'n2' }],
  });

  assert.equal(patched.plan.nodes.length, 3);
  assert.ok(patched.plan.edges.some((e) => e.from === 'lead' && e.to === 'n3'), 'edge from lead is preserved');
  assert.ok(!patched.plan.edges.some((e) => e.from === 'n1' && e.to === 'n2'), 'removed edge is dropped');
  assert.ok(!patched.plan.edges.some((e) => e.to === 'lead'), 'edge into lead is rejected');
  assert.deepEqual(patched.removeEdges, [{ from: 'n1', to: 'n2' }]);
  assert.equal(patched.plan.nodes.find((n) => n.id === 'n3').structured, true, 'structured edge marks source node');
});

test('structured edge automatically requests outputSchema even when node.structured is omitted', async () => {
  const specs = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        specs.push(spec);
        return Promise.resolve({
          childId: 'kid-' + spec.label,
          result: Promise.resolve(spec.outputSchema
            ? { structured: { summary: 'ok' }, output: [], stopReason: 'completed' }
            : { output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };

  const canvas = normalizeCanvas({
    task: '总任务',
    nodes: [
      { id: 'a', label: '结构化产出', role: '产 JSON' },
      { id: 'b', label: '消费者', role: '读 JSON' },
    ],
    edges: [
      { from: 'lead', to: 'a', type: 'prompt' },
      { from: 'a', to: 'b', type: 'structured' },
    ],
  });
  // Simulate a plan where structured flag was not pre-set on node 'a'
  const plan = {
    task: '总任务',
    nodes: canvas.nodes.map((n) => ({ ...n, structured: false })),
    edges: canvas.edges,
  };

  const exec = { agent: { id: 's2' }, signal: new AbortController().signal };
  const result = await executePlan(scope, plan, {}, exec);

  assert.equal(result.status, 'done');
  assert.ok(specs[0].outputSchema, 'upstream of structured edge gets outputSchema');
  assert.equal(specs[1].outputSchema, undefined, 'downstream without structured out-edge has no outputSchema');
  assert.ok(specs[1].prompt[0].text.includes('{"summary":"ok"}'), 'structured JSON reaches downstream');
});

test('executePlan supports task override and reset across paused Lead runs', async () => {
  const runs = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        runs.push(spec.prompt[0].text);
        return Promise.resolve({
          childId: 'kid-' + runs.length,
          result: Promise.resolve({ output: [{ type: 'text', text: 'out-' + runs.length }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };

  const plan = {
    task: '',
    nodes: [
      { id: 'n1', kind: 'agent', label: '调研', role: '做调研' },
      { id: 'l1', kind: 'lead', label: '拍板', role: '决定路线' },
      { id: 'n2', kind: 'agent', label: '落地', role: '执行' },
    ],
    edges: [
      { from: 'lead', to: 'n1', type: 'prompt' },
      { from: 'n1', to: 'l1', type: 'prompt' },
      { from: 'l1', to: 'n2', type: 'prompt' },
    ],
  };
  const exec = { agent: { id: 's-reset' }, signal: new AbortController().signal };

  // Empty task without override is rejected
  const missing = await executePlan(scope, plan, {}, exec);
  assert.ok(missing.error);

  // Override task pauses at Lead
  const paused = await executePlan(scope, plan, { task: '新任务 A' }, exec);
  assert.equal(paused.status, 'need-lead');
  assert.ok(runs[0].includes('【总任务】新任务 A'));

  // Reset discards paused progress and re-runs n1 from scratch
  const restarted = await executePlan(scope, plan, { task: '新任务 A', reset: true }, exec);
  assert.equal(restarted.status, 'need-lead');
  assert.equal(runs.length, 2, 'n1 ran a second time after reset');

  // Resume with leadResult finishes n2
  const done = await executePlan(scope, plan, { task: '新任务 A', leadResult: '选方案 A' }, exec);
  assert.equal(done.status, 'done');
  assert.equal(runs.length, 3);
  assert.ok(runs[2].includes('选方案 A'));
});

test('session-ref continues upstream session on repeated runs', async () => {
  const calls = [];
  let seq = 0;
  const scope = {
    subagents: {
      startActivation(spec) {
        const assigned = spec.childId || ('child-' + (++seq));
        calls.push({ label: spec.label, childId: spec.childId || null, assigned });
        return Promise.resolve({
          childId: assigned,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };

  const plan = {
    task: '持续会话任务',
    nodes: [
      { id: 'u1', kind: 'agent', label: '上游', role: '准备', keepSession: true },
      { id: 'd1', kind: 'agent', label: '下游', role: '继续' },
    ],
    edges: [
      { from: 'lead', to: 'u1', type: 'prompt' },
      { from: 'u1', to: 'd1', type: 'session-ref' },
    ],
  };
  const exec = { agent: { id: 's-sess' }, signal: new AbortController().signal };

  const run1 = await executePlan(scope, plan, {}, exec);
  assert.equal(run1.status, 'done');
  assert.equal(calls[1].childId, calls[0].assigned, 'first run continues upstream session');

  const run2 = await executePlan(scope, plan, {}, exec);
  assert.equal(run2.status, 'done');
  assert.equal(calls[2].childId, calls[0].assigned, 'upstream resumes via keepSession');
  assert.equal(calls[3].childId, calls[0].assigned, 'second run still continues upstream session');
});

test('failed subagent is reported in failed list and warns downstream prompt', async () => {
  const prompts = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        prompts.push(spec.prompt[0].text);
        if (spec.label.endsWith('#bad')) {
          return Promise.reject(new Error('model not found'));
        }
        return Promise.resolve({
          childId: 'kid-ok',
          result: Promise.resolve({ output: [{ type: 'text', text: 'handled' }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };

  const plan = {
    task: '容错测试',
    nodes: [
      { id: 'bad', kind: 'agent', label: '出错节点', role: '会失败' },
      { id: 'next', kind: 'agent', label: '下游节点', role: '收尾' },
    ],
    edges: [
      { from: 'lead', to: 'bad', type: 'prompt' },
      { from: 'bad', to: 'next', type: 'prompt' },
    ],
  };
  const exec = { agent: { id: 's-fail' }, signal: new AbortController().signal };
  const result = await executePlan(scope, plan, {}, exec);

  assert.equal(result.status, 'done');
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, 'bad');
  assert.equal(result.failed[0].reason, 'activation-failed');
  assert.ok(prompts[1].includes('该上游节点执行失败'), 'downstream prompt warns about upstream failure');
});

test('inspectPlan returns empty snapshot for unknown session', () => {
  const snap = inspectPlan('non-existent-session');
  assert.equal(snap.hasCanvas, false);
  assert.equal(snap.enabled, false);
  assert.deepEqual(snap.nodes, []);
  assert.deepEqual(snap, JSON.parse(JSON.stringify(snap)), 'inspectPlan output is lossless JSON');
});

test('executePlan starts newly unblocked children immediately without waiting for slow siblings', async () => {
  const events = [];
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        events.push('start:' + id);
        const waitMs = id === 'slow' ? 70 : 10;
        return Promise.resolve({
          childId: 'kid-' + id,
          result: delay(waitMs).then(() => {
            events.push('end:' + id);
            return { output: [{ type: 'text', text: 'ok:' + id }], stopReason: 'completed' };
          }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };

  const plan = {
    task: '并发池测试',
    nodes: [
      { id: 'fast', kind: 'agent', label: '脚手架', role: '快节点' },
      { id: 'slow', kind: 'agent', label: '回响系统', role: '慢节点' },
      { id: 'child', kind: 'agent', label: '美术', role: '只依赖脚手架' },
    ],
    edges: [
      { from: 'lead', to: 'fast', type: 'prompt' },
      { from: 'lead', to: 'slow', type: 'prompt' },
      { from: 'fast', to: 'child', type: 'prompt' },
    ],
  };

  const exec = { agent: { id: 's-pool' }, signal: new AbortController().signal };
  const result = await executePlan(scope, plan, {}, exec);

  assert.equal(result.status, 'done');
  const childStart = events.indexOf('start:child');
  const slowEnd = events.indexOf('end:slow');
  assert.ok(childStart >= 0 && slowEnd >= 0);
  assert.ok(childStart < slowEnd, 'child started before slow sibling finished: ' + events.join(', '));
});

test('normalizeCanvas promotes hand-authored root Lead and auto-wires missing lead edges', () => {
  const promoted = normalizeCanvas({
    task: '回声塔',
    nodes: [
      { id: 'n1', kind: 'lead', label: '总控·策划', role: '总控' },
      { id: 'n2', kind: 'agent', label: '脚手架', role: '搭框架' },
      { id: 'n3', kind: 'lead', label: '集成交付', role: '收尾' },
    ],
    edges: [
      { from: 'n1', to: 'n2', type: 'prompt' },
      { from: 'n2', to: 'n3', type: 'prompt' },
    ],
  });
  assert.equal(promoted.nodes.filter((n) => n.id === 'lead').length, 1);
  assert.equal(promoted.nodes.filter((n) => n.kind === 'lead').length, 2, 'no duplicate entry Lead created');
  assert.ok(promoted.edges.some((e) => e.from === 'lead' && e.to === 'n2'), 'promoted Lead edges rewritten to lead');

  const autoWired = normalizeCanvas({
    task: '自动连线测试',
    nodes: [
      { id: 'a', label: '步骤A', role: 'A' },
      { id: 'b', label: '步骤B', role: 'B' },
    ],
    edges: [{ from: 'a', to: 'b', type: 'prompt' }],
  });
  assert.ok(autoWired.edges.some((e) => e.from === 'lead' && e.to === 'a'), 'entry Lead auto-wired to root node');
});

test('analyzeCanvasWarnings flags dead-end subagents when a downstream Lead exists', () => {
  const warnings = analyzeCanvasWarnings(
    [
      { id: 'lead', kind: 'lead', label: 'Lead' },
      { id: 'n2', kind: 'agent', label: '脚手架' },
      { id: 'n3', kind: 'agent', label: '玩家控制器' },
      { id: 'n9', kind: 'lead', label: '集成交付' },
    ],
    [
      { from: 'lead', to: 'n2' },
      { from: 'lead', to: 'n3' },
      { from: 'n2', to: 'n9' },
    ],
  );
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('玩家控制器'));

  // No false warning in a simple chain with no downstream Lead
  const noWarn = analyzeCanvasWarnings(
    [{ id: 'lead', kind: 'lead', label: 'Lead' }, { id: 'a', kind: 'agent', label: 'A' }],
    [{ from: 'lead', to: 'a' }],
  );
  assert.equal(noWarn.length, 0);

  // No false warning when the only downstream Lead is already an ancestor of the terminal agent
  const afterLead = analyzeCanvasWarnings(
    [
      { id: 'lead', kind: 'lead', label: 'Lead' },
      { id: 'a', kind: 'agent', label: '方案' },
      { id: 'pick', kind: 'lead', label: 'Lead 拍板' },
      { id: 'exec', kind: 'agent', label: '执行落地' },
    ],
    [
      { from: 'lead', to: 'a' },
      { from: 'a', to: 'pick' },
      { from: 'pick', to: 'exec' },
    ],
  );
  assert.equal(afterLead.length, 0);
});

test('briefFor forbids process monologue and requires incomplete delivery marker', () => {
  const brief = briefFor(
    { task: '测试', nodes: [{ id: 'a', kind: 'agent', label: '美术', role: '画图' }], edges: [{ from: 'lead', to: 'a' }] },
    { id: 'a', kind: 'agent', label: '美术', role: '画图' },
    {},
  );
  assert.ok(brief.includes('不要包含思考独白'));
  assert.ok(brief.includes('【未完全交付】'));
});

test('executePlan stops immediately on AbortSignal without launching downstream nodes', async () => {
  const launched = [];
  const ac = new AbortController();
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        launched.push(id);
        return Promise.resolve({
          childId: 'kid-' + id,
          result: new Promise((resolve) => {
            setTimeout(() => {
              ac.abort();
              resolve({ output: [{ type: 'text', text: 'cancelled' }], stopReason: 'aborted' });
            }, 15);
          }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };

  const plan = {
    task: '取消测试',
    nodes: [
      { id: 'n1', kind: 'agent', label: '第一步', role: '1' },
      { id: 'n2', kind: 'agent', label: '第二步', role: '2' },
    ],
    edges: [
      { from: 'lead', to: 'n1', type: 'prompt' },
      { from: 'n1', to: 'n2', type: 'prompt' },
    ],
  };

  const result = await executePlan(scope, plan, {}, { agent: { id: 's-abort' }, signal: ac.signal });
  assert.ok(result.error && result.error.includes('取消'));
  assert.deepEqual(launched, ['n1'], 'downstream n2 must never start after abort');
});

test('applyPatch clears structured flag when structured edge is removed and updates task', () => {
  const base = {
    task: '旧任务',
    nodes: [
      { id: 'a', kind: 'agent', label: '上游', role: 'A', structured: true },
      { id: 'b', kind: 'agent', label: '下游', role: 'B', structured: false },
    ],
    edges: [
      { from: 'lead', to: 'a', type: 'prompt' },
      { from: 'a', to: 'b', type: 'structured' },
    ],
  };
  const patched = applyPatch(base, {
    task: '新任务',
    removeEdges: [{ from: 'a', to: 'b', type: 'structured' }],
    edges: [{ from: 'a', to: 'b', type: 'prompt' }],
  });
  assert.equal(patched.taskPatched, true);
  assert.equal(patched.plan.task, '新任务');
  assert.equal(patched.plan.nodes.find((n) => n.id === 'a').structured, false);
});

test('normalizeCanvas deduplicates duplicate node ids so DAG stays valid', () => {
  const canvas = normalizeCanvas({
    task: '去重测试',
    nodes: [
      { id: 'n1', label: '节点A', role: 'A' },
      { id: 'n1', label: '节点B', role: 'B' },
    ],
    edges: [],
  });
  const ids = canvas.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, 'all node ids are unique');
  assert.ok(orderNodes({ nodes: withoutEntry(canvas.nodes), edges: canvas.edges }), 'deduplicated graph is acyclic');
});

test('executePlan flags subagents that return empty prose without structured output', async () => {
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        if (id === 'silent') {
          return Promise.resolve({
            childId: 'kid-silent',
            result: Promise.resolve({ output: [], stopReason: 'completed' }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-json',
          result: Promise.resolve({ structured: { ok: true }, output: [], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };

  const plan = {
    task: '空输出检查',
    nodes: [
      { id: 'silent', kind: 'agent', label: '静默节点', role: '无文本' },
      { id: 'json', kind: 'agent', label: '结构化节点', role: '产 JSON' },
    ],
    edges: [
      { from: 'lead', to: 'silent', type: 'prompt' },
      { from: 'lead', to: 'json', type: 'prompt' },
      { from: 'json', to: 'silent', type: 'structured' },
    ],
  };

  const result = await executePlan(scope, plan, {}, { agent: { id: 's-empty' }, signal: new AbortController().signal });
  assert.equal(result.status, 'done');
  assert.deepEqual(result.emptyOutputs, [{ id: 'silent', label: '静默节点' }]);
  assert.deepEqual(result, JSON.parse(JSON.stringify(result)), 'result is lossless JSON');
});

test('terminal Lead finishes directly with status done and finalLead without redundant callback', async () => {
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'out:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const plan = {
    task: '终审测试',
    nodes: [
      { id: 'a', kind: 'agent', label: '方案', role: '出方案' },
      { id: 'pick', kind: 'lead', label: 'Lead 拍板', role: '二选一' },
      { id: 'exec', kind: 'agent', label: '执行', role: '落地' },
      { id: 'final', kind: 'lead', label: 'Lead 终审', role: '验收交付' },
    ],
    edges: [
      { from: 'lead', to: 'a', type: 'prompt' },
      { from: 'a', to: 'pick', type: 'prompt' },
      { from: 'pick', to: 'exec', type: 'prompt' },
      { from: 'exec', to: 'final', type: 'prompt' },
      { from: 'exec', to: 'final', type: 'session-ref' },
    ],
  };
  const exec = { agent: { id: 's-term-lead' }, signal: new AbortController().signal };

  // Intermediate Lead MUST pause with need-lead
  const step1 = await executePlan(scope, plan, {}, exec);
  assert.equal(step1.status, 'need-lead');
  assert.equal(step1.node.label, 'Lead 拍板');

  // Resuming runs exec, then terminal Lead finishes directly with status done + finalLead
  const step2 = await executePlan(scope, plan, { leadResult: '选方案 A' }, exec);
  assert.equal(step2.status, 'done');
  assert.equal(step2.finalLead.label, 'Lead 终审');
  assert.equal(step2.sessions[0].childId, 'kid-exec', 'session-ref handover preserved on finalLead');
  assert.equal(inspectPlan('s-term-lead').paused, false, 'run state cleaned up after terminal Lead');
});

test('systemPrompt.context injects active canvas per session and stays silent for disabled/other sessions', async () => {
  let syncHandler = null;
  let contextProvider = null;
  const mockCtx = {
    inject(services, cb) {
      if (services.includes('systemPrompt')) {
        cb({
          systemPrompt: {
            context(entry) { contextProvider = entry; },
          },
          effect(fn) { fn(); },
        });
      }
      if (services.includes('commands')) {
        cb({
          commands: {
            register(cmd) { if (cmd.name === 'canvas-sync') syncHandler = cmd.handler; },
          },
          effect(fn) { fn(); },
        });
      }
    },
  };
  apply(mockCtx);
  assert.ok(contextProvider && typeof contextProvider.text === 'function', 'registers systemPrompt.context');
  assert.ok(syncHandler, 'registers canvas-sync command');

  const sid = 's-ctx-test';
  const plan = {
    task: '',
    nodes: [
      { id: 'a', kind: 'agent', label: '调研', role: '调研' },
      { id: 'pick', kind: 'lead', label: 'Lead 拍板', role: '拍板' },
      { id: 'b', kind: 'agent', label: '执行', role: '执行' },
    ],
    edges: [
      { from: 'lead', to: 'a', type: 'prompt' },
      { from: 'a', to: 'pick', type: 'prompt' },
      { from: 'pick', to: 'b', type: 'prompt' },
    ],
  };

  // Disabled canvas -> empty string
  syncHandler({ agent: { id: sid }, rawInput: encodeURIComponent(JSON.stringify({ enabled: false, plan })) });
  assert.equal(contextProvider.text({ agent: { id: sid } }), '');

  // Enabled canvas -> injected ONLY for this session, empty for unrelated/subagent sessions
  syncHandler({ agent: { id: sid }, rawInput: encodeURIComponent(JSON.stringify({ enabled: true, plan })) });
  const activeText = contextProvider.text({ agent: { id: sid } });
  assert.ok(activeText.includes('[Workflow Canvas Active]'));
  assert.ok(activeText.includes('canvas_workflow'));
  assert.equal(contextProvider.text({ agent: { id: 'other-session' } }), '');
  assert.equal(contextProvider.text({}), '');
  assert.equal(sessionIdFromContext({ agent: { id: sid } }), sid);

  // When paused at intermediate Lead -> paused reminder names the Lead node
  const scope = {
    subagents: {
      startActivation() {
        return Promise.resolve({
          childId: 'kid-a',
          result: Promise.resolve({ output: [{ type: 'text', text: 'done-a' }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const paused = await executePlan(scope, plan, { task: '新任务' }, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(paused.status, 'need-lead');
  const pausedText = buildActiveCanvasContext(sid);
  assert.ok(pausedText.includes('Paused at Lead Step'));
  assert.ok(pausedText.includes('Lead 拍板'));

  // Disable canvas -> clears context immediately
  syncHandler({ agent: { id: sid }, rawInput: encodeURIComponent(JSON.stringify({ enabled: false, plan })) });
  assert.equal(contextProvider.text({ agent: { id: sid } }), '');
});

test('solo chained Leads and dead-end subagents are warned and skipped cleanly at run time', async () => {
  const spawned = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        spawned.push(id);
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const nodes = [
    { id: 'lead', kind: 'lead', label: 'Lead' },
    { id: 'a', kind: 'agent', label: 'A', role: 'A' },
    { id: 'dead', kind: 'agent', label: '无出边', role: 'D' },
    { id: 'l1', kind: 'lead', label: 'L1', role: '1' },
    { id: 'l2', kind: 'lead', label: 'L2', role: '' },
  ];
  const edges = [
    { from: 'lead', to: 'a', type: 'prompt' },
    { from: 'lead', to: 'dead', type: 'prompt' },
    { from: 'a', to: 'l1', type: 'prompt' },
    { from: 'l1', to: 'l2', type: 'prompt' },
  ];
  const warns = analyzeCanvasWarnings(nodes, edges);
  assert.ok(warns.some((w) => w.includes('未连入子代理且未填写分工') && w.includes('L2')));
  assert.ok(warns.some((w) => w.includes('没有出边') && w.includes('无出边')));

  const res = await executePlan(
    scope,
    { task: 't', nodes: withoutEntry(nodes), edges },
    {},
    { agent: { id: 's-l2l' }, signal: new AbortController().signal },
  );
  assert.equal(res.status, 'done');
  assert.equal(res.finalLead.label, 'L1');
  assert.deepEqual(spawned, ['a'], 'dead-end subagent is skipped without spawning');
  assert.ok(res.skipped.includes('L2') && res.skipped.includes('无出边'));
});

test('clearMemory forgets saved keepSession child sessions and active context prompts memory confirmation', async () => {
  let seq = 0;
  const seenChildIds = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        seenChildIds.push(spec.childId || null);
        const assigned = spec.childId || ('kid-mem-' + (++seq));
        return Promise.resolve({
          childId: assigned,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  let syncHandler = null;
  apply({
    inject(services, cb) {
      if (services.includes('commands')) {
        cb({
          commands: { register(cmd) { if (cmd.name === 'canvas-sync') syncHandler = cmd.handler; } },
          effect(fn) { fn(); },
        });
      }
    },
  });

  const sid = 's-mem-confirm';
  const plan = {
    task: '记忆测试',
    nodes: [{ id: 'm1', kind: 'agent', label: '记忆节点', role: '记住内容', keepSession: true }],
    edges: [{ from: 'lead', to: 'm1', type: 'prompt' }],
  };
  syncHandler({ agent: { id: sid }, rawInput: encodeURIComponent(JSON.stringify({ enabled: true, plan })) });

  // Before first run: no saved memory yet -> no memory confirmation line
  assert.equal(buildActiveCanvasContext(sid).includes('clearMemory'), false);

  // Run 1 creates kid-mem-1
  await executePlan(scope, plan, {}, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(seenChildIds[0], null);
  assert.equal(buildActiveCanvasContext(sid).includes('clearMemory'), true, 'active context now reminds agent to ask about keeping/clearing memory');

  // Run 2 without clearMemory reuses kid-mem-1
  await executePlan(scope, plan, { reset: true }, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(seenChildIds[1], 'kid-mem-1');

  // Run 3 with clearMemory: true starts a fresh session
  await executePlan(scope, plan, { reset: true, clearMemory: true }, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(seenChildIds[2], null, 'clearMemory clears prior keepSession childId');
});

test('executePlan circuit-breaks before launching downstream waves on permission/sandbox failure', async () => {
  const launched = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        launched.push(id);
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({
            output: [{ type: 'text', text: '【未完全交付】Error: sandbox-local: windows-acl workspace grant failed (Access is denied)' }],
            stopReason: 'completed',
          }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  assert.equal(isPermissionFailure({ ok: false, text: 'Permission denied' }), true);
  assert.equal(isPermissionFailure({ ok: true, text: 'normal output' }), false);

  const plan = {
    task: '熔断测试',
    nodes: [
      { id: 'w1', kind: 'agent', label: '第一波', role: '写文件' },
      { id: 'w2', kind: 'agent', label: '第二波', role: '继续干活' },
    ],
    edges: [
      { from: 'lead', to: 'w1', type: 'prompt' },
      { from: 'w1', to: 'w2', type: 'prompt' },
    ],
  };

  const res = await executePlan(scope, plan, {}, { agent: { id: 's-perm-halt' }, signal: new AbortController().signal });
  assert.equal(res.status, 'halted');
  assert.ok(res.error && res.error.includes('熔断'));
  assert.deepEqual(launched, ['w1'], 'downstream wave w2 must not be launched after permission halt');
});

test('memoryChildId pins a specific past session and temporary keepSession=false runs preserve saved memory', async () => {
  let seq = 0;
  const seenChildIds = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        seenChildIds.push(spec.childId || null);
        const assigned = spec.childId || ('kid-pick-' + (++seq));
        return Promise.resolve({
          childId: assigned,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const sid = 's-mem-pick';
  const baseEdges = [{ from: 'lead', to: 'n1', type: 'prompt' }];

  // Run 1: Memory ON -> saves kid-pick-1
  await executePlan(scope, { task: 'r1', nodes: [{ id: 'n1', kind: 'agent', label: 'A', role: 'A', keepSession: true }], edges: baseEdges }, {}, { agent: { id: sid }, signal: new AbortController().signal });
  // Run 2: Temporarily Memory OFF -> creates kid-pick-2 without overwriting kid-pick-1
  await executePlan(scope, { task: 'r2', nodes: [{ id: 'n1', kind: 'agent', label: 'A', role: 'A', keepSession: false }], edges: baseEdges }, { reset: true }, { agent: { id: sid }, signal: new AbortController().signal });
  // Run 3: Memory ON (latest) -> resumes saved kid-pick-1!
  await executePlan(scope, { task: 'r3', nodes: [{ id: 'n1', kind: 'agent', label: 'A', role: 'A', keepSession: true }], edges: baseEdges }, { reset: true }, { agent: { id: sid }, signal: new AbortController().signal });
  // Run 4: Memory ON with explicit memoryChildId = kid-pick-2 -> resumes kid-pick-2!
  await executePlan(scope, { task: 'r4', nodes: [{ id: 'n1', kind: 'agent', label: 'A', role: 'A', keepSession: true, memoryChildId: 'kid-pick-2' }], edges: baseEdges }, { reset: true }, { agent: { id: sid }, signal: new AbortController().signal });

  assert.deepEqual(seenChildIds, [null, null, 'kid-pick-1', 'kid-pick-2']);
});

test('executePlan honors configurable maxParallel limit from plan or args', async () => {
  let active = 0;
  let peak = 0;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const scope = {
    subagents: {
      startActivation(spec) {
        active += 1;
        peak = Math.max(peak, active);
        return Promise.resolve({
          childId: 'kid-' + spec.label,
          result: delay(20).then(() => {
            active -= 1;
            return { output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' };
          }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const nodes = [1, 2, 3, 4, 5, 6].map((i) => ({ id: 'p' + i, kind: 'agent', label: 'P' + i, role: 'r' }));
  const edges = nodes.map((n) => ({ from: 'lead', to: n.id, type: 'prompt' }));

  // maxParallel = 1 -> strictly serial
  await executePlan(scope, { task: 'serial', maxParallel: 1, nodes, edges }, {}, { agent: { id: 's-mp1' }, signal: new AbortController().signal });
  assert.equal(peak, 1);

  // maxParallel = 6 -> all 6 run concurrently
  peak = 0;
  await executePlan(scope, { task: 'wide', maxParallel: 6, nodes, edges }, {}, { agent: { id: 's-mp6' }, signal: new AbortController().signal });
  assert.equal(peak, 6);
});

test('retryFailed and fromNodes reuse succeeded nodes and re-run only failed/target nodes plus downstream', async () => {
  let failB = true;
  const spawned = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        spawned.push(id);
        if (id === 'b' && failB) {
          return Promise.reject(new Error('transient error'));
        }
        return Promise.resolve({
          childId: 'kid-' + id + '-' + spawned.length,
          result: Promise.resolve({ output: [{ type: 'text', text: 'out:' + id + '#' + spawned.length }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const sid = 's-partial-retry';
  const plan = {
    task: '局部重跑测试',
    nodes: [
      { id: 'a', kind: 'agent', label: '节点A', role: 'A' },
      { id: 'b', kind: 'agent', label: '节点B', role: 'B' },
      { id: 'c', kind: 'agent', label: '下游C', role: 'C' },
    ],
    edges: [
      { from: 'lead', to: 'a', type: 'prompt' },
      { from: 'lead', to: 'b', type: 'prompt' },
      { from: 'a', to: 'c', type: 'prompt' },
      { from: 'b', to: 'c', type: 'prompt' },
    ],
  };

  // Run 1: a succeeds, b fails, c runs with warning
  const r1 = await executePlan(scope, plan, {}, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(r1.status, 'done');
  assert.equal(r1.failed.length, 1);
  assert.equal(r1.failed[0].id, 'b');

  // Run 2: fix b and call retryFailed -> a is REUSED (not spawned), only b and downstream c re-run!
  spawned.length = 0;
  failB = false;
  const r2 = await executePlan(scope, plan, { retryFailed: true }, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(r2.status, 'done');
  assert.equal(r2.failed.length, 0);
  assert.deepEqual(spawned, ['b', 'c'], 'node a must be reused from cache without re-spawning');
  assert.deepEqual(r2.reused, ['节点A']);

  // Run 3: fromNodes=['下游C'] -> reuses both a and b, re-runs only c!
  spawned.length = 0;
  const r3 = await executePlan(scope, plan, { fromNodes: ['下游C'] }, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(r3.status, 'done');
  assert.deepEqual(spawned, ['c']);
  assert.deepEqual(r3.reused.sort(), ['节点A', '节点B']);
});

test('parseConditionDecision parses structured, JSON prose, binary, and multi-way switch/case verdicts', () => {
  const b1 = parseConditionDecision({ structured: { pass: true, reason: 'all ok' } }, '');
  assert.equal(b1.pass, true);
  assert.equal(b1.branch, 'true');
  assert.equal(b1.reason, 'all ok');

  const b2 = parseConditionDecision({}, '结论如下：{"pass": false, "reason": "单测失败"}');
  assert.equal(b2.pass, false);
  assert.equal(b2.branch, 'false');
  assert.equal(b2.reason, '单测失败');

  assert.equal(parseConditionDecision({}, 'true - passed').pass, true);
  assert.equal(parseConditionDecision({}, 'failed to build').pass, false);

  const sw = parseConditionDecision(
    { structured: { branch: '小修', reason: '只有一处拼写问题' } },
    '',
    ['通过', '小修', '重做'],
  );
  assert.equal(sw.branch, '小修');
  assert.equal(sw.branchLabel, '小修');
  assert.equal(sw.reason, '只有一处拼写问题');
});

test('condition node routes true/false branches, prunes unchosen path, and converges cleanly into Lead', async () => {
  let verdict = { pass: true, reason: '测试全通过' };
  const spawned = [];
  const specs = new Map();
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        spawned.push(id);
        specs.set(id, spec);
        if (id === 'gate') {
          return Promise.resolve({
            childId: 'kid-gate',
            result: Promise.resolve({
              structured: verdict,
              output: [{ type: 'text', text: JSON.stringify(verdict) }],
              stopReason: 'completed',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'out:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const canvas = normalizeCanvas({
    task: '条件分流测试',
    nodes: [
      { id: 'run', kind: 'agent', label: '执行测试', role: '跑测试' },
      { id: 'gate', kind: 'condition', label: '是否通过', role: '判断测试是否全通过' },
      { id: 'yes_node', kind: 'agent', label: '打包发布', role: '整理发布' },
      { id: 'no_node', kind: 'agent', label: '定位修复', role: '修 bug' },
      { id: 'review', kind: 'lead', label: 'Lead 终审', role: '汇总交付' },
    ],
    edges: [
      { from: 'lead', to: 'run', type: 'prompt' },
      { from: 'run', to: 'gate', type: 'prompt' },
      { from: 'gate', to: 'yes_node', type: 'prompt', branch: 'true' },
      { from: 'gate', to: 'no_node', type: 'prompt', branch: 'false' },
      { from: 'yes_node', to: 'review', type: 'prompt' },
      { from: 'no_node', to: 'review', type: 'prompt' },
    ],
  });
  assert.ok(!canvas.error);
  const plan = { task: canvas.task, nodes: withoutEntry(canvas.nodes), edges: canvas.edges };

  // Branch 1: pass=true -> runs yes_node, skips no_node, converges to terminal Lead
  const rTrue = await executePlan(scope, plan, {}, { agent: { id: 's-cond-true' }, signal: new AbortController().signal });
  assert.equal(rTrue.status, 'done');
  assert.deepEqual(spawned, ['run', 'gate', 'yes_node']);
  assert.equal(specs.get('gate').agentPreset, 'minimal', 'condition node always runs with minimal preset');
  assert.ok(specs.get('gate').outputSchema, 'condition node requests structured boolean outputSchema');
  assert.deepEqual(rTrue.branchSkipped, ['定位修复']);
  assert.equal(rTrue.decisions.length, 1);
  assert.equal(rTrue.decisions[0].pass, true);
  assert.equal(rTrue.finalLead.label, 'Lead 终审');
  assert.deepEqual(rTrue.finalLead.needs, ['打包发布'], 'converging Lead only depends on the active branch');

  // Branch 2: pass=false -> runs no_node, skips yes_node, converges to terminal Lead
  spawned.length = 0;
  verdict = { pass: false, reason: '存在 2 个失败用例' };
  const rFalse = await executePlan(scope, plan, {}, { agent: { id: 's-cond-false' }, signal: new AbortController().signal });
  assert.equal(rFalse.status, 'done');
  assert.deepEqual(spawned, ['run', 'gate', 'no_node']);
  assert.deepEqual(rFalse.branchSkipped, ['打包发布']);
  assert.equal(rFalse.decisions[0].pass, false);
  assert.deepEqual(rFalse.finalLead.needs, ['定位修复']);
});

test('upstream failure feeding a condition node routes to false branch instead of halting', async () => {
  const spawned = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        spawned.push(id);
        if (id === 'run') {
          return Promise.resolve({
            childId: 'kid-run',
            result: Promise.resolve({
              output: [{ type: 'text', text: 'Error: EACCES permission denied' }],
              stopReason: 'failed',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        if (id === 'gate') {
          const promptText = Array.isArray(spec.prompt) ? spec.prompt.map((b) => b.text || '').join('\n') : String(spec.prompt || '');
          const sawFailure = promptText.includes('执行失败');
          return Promise.resolve({
            childId: 'kid-gate',
            result: Promise.resolve({
              structured: { pass: !sawFailure, reason: sawFailure ? '上游报错' : '成功' },
              output: [{ type: 'text', text: '' }],
              stopReason: 'completed',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'fallback handled' }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const plan = {
    task: '异常兜底分流',
    nodes: [
      { id: 'run', kind: 'agent', label: '执行', role: '执行' },
      { id: 'gate', kind: 'condition', label: '成功了吗', role: '判断是否成功' },
      { id: 'ok_step', kind: 'agent', label: '继续', role: '继续' },
      { id: 'err_step', kind: 'agent', label: '降级方案', role: '降级处理' },
    ],
    edges: [
      { from: 'lead', to: 'run', type: 'prompt' },
      { from: 'run', to: 'gate', type: 'prompt' },
      { from: 'gate', to: 'ok_step', type: 'prompt', branch: 'true' },
      { from: 'gate', to: 'err_step', type: 'prompt', branch: 'false' },
    ],
  };
  const res = await executePlan(scope, plan, {}, { agent: { id: 's-cond-fail-route' }, signal: new AbortController().signal });
  assert.equal(res.status, 'done', 'must not circuit-break when upstream failure feeds a condition node');
  assert.deepEqual(spawned, ['run', 'gate', 'err_step']);
  assert.deepEqual(res.branchSkipped, ['继续']);
  assert.equal(res.decisions[0].pass, false);
});

test('switch/case condition node routes 3+ named branches and blocks ancestor side session-ref bypass', async () => {
  let chosenBranch = '小修';
  const spawned = [];
  const specs = new Map();
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        spawned.push(id);
        specs.set(id, spec);
        if (id === 'router') {
          return Promise.resolve({
            childId: 'kid-router',
            result: Promise.resolve({
              structured: { branch: chosenBranch, reason: '命中 ' + chosenBranch },
              output: [{ type: 'text', text: '' }],
              stopReason: 'completed',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'out:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const canvas = normalizeCanvas({
    task: '三态代码审查分流',
    nodes: [
      { id: 'scan', kind: 'agent', label: '代码实现', role: '实现代码' },
      { id: 'router', kind: 'condition', label: '审查分级', role: '按严重程度分流', branches: ['通过', '小修', '重做'] },
      { id: 'ship', kind: 'agent', label: '直接发布', role: '发布' },
      { id: 'patch', kind: 'agent', label: '局部修复', role: '接着原会话修小问题' },
      { id: 'redo', kind: 'agent', label: '推倒重做', role: '重新设计' },
      { id: 'final', kind: 'lead', label: 'Lead 终审', role: '验收' },
    ],
    edges: [
      { from: 'lead', to: 'scan', type: 'prompt' },
      { from: 'scan', to: 'router', type: 'prompt' },
      { from: 'router', to: 'ship', type: 'prompt', branch: '通过' },
      { from: 'router', to: 'patch', type: 'prompt', branch: '小修' },
      { from: 'scan', to: 'patch', type: 'session-ref' },
      { from: 'router', to: 'redo', type: 'prompt', branch: '重做' },
      { from: 'ship', to: 'final', type: 'prompt' },
      { from: 'patch', to: 'final', type: 'prompt' },
      { from: 'redo', to: 'final', type: 'prompt' },
    ],
  });
  assert.ok(!canvas.error);
  const plan = { task: canvas.task, nodes: withoutEntry(canvas.nodes), edges: canvas.edges };

  // Case 1: picks '小修' -> patch runs AND resumes scan's warm session via side session-ref!
  const rPatch = await executePlan(scope, plan, {}, { agent: { id: 's-switch-patch' }, signal: new AbortController().signal });
  assert.equal(rPatch.status, 'done');
  assert.deepEqual(spawned, ['scan', 'router', 'patch']);
  assert.equal(specs.get('patch').childId, 'kid-scan', 'patch resumes scan warm session when selected');
  const schema = specs.get('router').outputSchema;
  assert.deepEqual(schema.properties.branches.items.enum, ['通过', '小修', '重做']);
  // Guard against DSH's strict JSON schema subset (rejects maxItems/minItems/etc.).
  const ALLOWED_SCHEMA_KEYS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description']);
  const checkSchemaKeys = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      assert.ok(ALLOWED_SCHEMA_KEYS.has(key), 'unsupported DSH outputSchema keyword: ' + key);
      if (key === 'properties' && obj.properties) {
        for (const prop of Object.values(obj.properties)) checkSchemaKeys(prop);
      } else if (key === 'items') {
        checkSchemaKeys(obj.items);
      }
    }
  };
  checkSchemaKeys(schema);
  assert.deepEqual(rPatch.branchSkipped.sort(), ['推倒重做', '直接发布']);
  assert.equal(rPatch.decisions[0].branch, '小修');

  // Case 2: picks '通过' -> patch MUST stay pruned even though scan --session-ref--> patch exists!
  spawned.length = 0;
  chosenBranch = '通过';
  const rShip = await executePlan(scope, plan, {}, { agent: { id: 's-switch-ship' }, signal: new AbortController().signal });
  assert.equal(rShip.status, 'done');
  assert.deepEqual(spawned, ['scan', 'router', 'ship'], 'side session-ref from ancestor must not bypass blocked branch');
  assert.deepEqual(rShip.branchSkipped.sort(), ['局部修复', '推倒重做']);
  assert.deepEqual(rShip.finalLead.needs, ['直接发布']);
});

test('condition node handles multiMatch parallel branches and zero-match full skip cleanly', async () => {
  let matched = ['前端', '文档'];
  const spawned = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        spawned.push(id);
        if (id === 'router') {
          return Promise.resolve({
            childId: 'kid-router',
            result: Promise.resolve({
              structured: { branches: matched, reason: matched.length ? '命中多个' : '均不满足' },
              output: [{ type: 'text', text: '' }],
              stopReason: 'completed',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'done:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const canvas = normalizeCanvas({
    task: '多选与零命中测试',
    nodes: [
      { id: 'audit', kind: 'agent', label: '代码体检', role: '体检' },
      { id: 'router', kind: 'condition', label: '分发器', role: '按问题多选分发', branches: ['前端', '后端', '文档'], multiMatch: true },
      { id: 'fe', kind: 'agent', label: '修前端', role: '前端' },
      { id: 'be', kind: 'agent', label: '修后端', role: '后端' },
      { id: 'doc', kind: 'agent', label: '改文档', role: '文档' },
      { id: 'final', kind: 'lead', label: 'Lead 终审', role: '汇总' },
    ],
    edges: [
      { from: 'lead', to: 'audit', type: 'prompt' },
      { from: 'audit', to: 'router', type: 'prompt' },
      { from: 'router', to: 'fe', type: 'prompt', branch: '前端' },
      { from: 'router', to: 'be', type: 'prompt', branch: '后端' },
      { from: 'router', to: 'doc', type: 'prompt', branch: '文档' },
      { from: 'fe', to: 'final', type: 'prompt' },
      { from: 'be', to: 'final', type: 'prompt' },
      { from: 'doc', to: 'final', type: 'prompt' },
    ],
  });
  const plan = { task: canvas.task, nodes: withoutEntry(canvas.nodes), edges: canvas.edges };

  // Multi-match: 前端 + 文档 run in parallel, 后端 is pruned, final Lead receives both!
  const rMulti = await executePlan(scope, plan, {}, { agent: { id: 's-multi' }, signal: new AbortController().signal });
  assert.equal(rMulti.status, 'done');
  assert.ok(spawned.includes('fe') && spawned.includes('doc') && !spawned.includes('be'));
  assert.deepEqual(rMulti.branchSkipped, ['修后端']);
  assert.deepEqual(rMulti.decisions[0].branches, ['前端', '文档']);
  assert.deepEqual(rMulti.finalLead.needs.sort(), ['修前端', '改文档']);

  // Zero-match with downstream terminal Lead: skips intermediate branches and jumps directly to Lead 终审 with status notice!
  spawned.length = 0;
  matched = [];
  const rZero = await executePlan(scope, plan, {}, { agent: { id: 's-zero' }, signal: new AbortController().signal });
  assert.equal(rZero.status, 'done');
  assert.deepEqual(spawned, ['audit', 'router']);
  assert.deepEqual(rZero.decisions[0].branches, []);
  assert.equal(rZero.decisions[0].fallbackLead, 'Lead 终审');
  assert.deepEqual(rZero.branchSkipped.sort(), ['修前端', '修后端', '改文档']);
  assert.equal(rZero.finalLead.label, 'Lead 终审');
  assert.deepEqual(rZero.finalLead.needs, ['分发器']);
  assert.ok(rZero.hint.includes('均未命中') && rZero.hint.includes('直接转交'));

  // Zero-match with intermediate Lead -> pauses at that nearest Lead (`need-lead`) with notice, then runs downstream after leadResult!
  const midCanvas = normalizeCanvas({
    task: '中间 Lead 兜底测试',
    nodes: [
      { id: 'audit', kind: 'agent', label: '体检', role: '体检' },
      { id: 'router', kind: 'condition', label: '分发器', role: '分流', branches: ['前端', '后端'] },
      { id: 'fe', kind: 'agent', label: '修前端', role: '前端' },
      { id: 'be', kind: 'agent', label: '修后端', role: '后端' },
      { id: 'gate', kind: 'lead', label: 'Lead 拍板', role: '人工拍板' },
      { id: 'wrap', kind: 'agent', label: '收尾报告', role: '写报告' },
    ],
    edges: [
      { from: 'lead', to: 'audit', type: 'prompt' },
      { from: 'audit', to: 'router', type: 'prompt' },
      { from: 'router', to: 'fe', type: 'prompt', branch: '前端' },
      { from: 'router', to: 'be', type: 'prompt', branch: '后端' },
      { from: 'fe', to: 'gate', type: 'prompt' },
      { from: 'be', to: 'gate', type: 'prompt' },
      { from: 'gate', to: 'wrap', type: 'prompt' },
    ],
  });
  const midPlan = { task: midCanvas.task, nodes: withoutEntry(midCanvas.nodes), edges: midCanvas.edges };
  spawned.length = 0;
  const rMidPause = await executePlan(scope, midPlan, {}, { agent: { id: 's-zero-mid' }, signal: new AbortController().signal });
  assert.equal(rMidPause.status, 'need-lead', 'jumps straight to nearest intermediate Lead instead of pruning it');
  assert.equal(rMidPause.node.label, 'Lead 拍板');
  assert.deepEqual(spawned, ['audit', 'router']);
  assert.deepEqual(rMidPause.branchSkipped.sort(), ['修前端', '修后端']);
  assert.ok(rMidPause.hint.includes('均未命中') && rMidPause.hint.includes('直接转交'));

  // Resume after Lead decision -> downstream 'wrap' executes cleanly!
  spawned.length = 0;
  const rMidDone = await executePlan(scope, midPlan, { leadResult: '无需修复，直接出报告' }, { agent: { id: 's-zero-mid' }, signal: new AbortController().signal });
  assert.equal(rMidDone.status, 'done');
  assert.deepEqual(spawned, ['wrap']);
});

test('failed condition node never guesses a branch, hands off to nearest Lead or halts, and recovers via retryFailed', async () => {
  let crashGate = true;
  const spawned = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        spawned.push(id);
        if (id === 'gate') {
          if (crashGate) return Promise.reject(new Error('429 rate limit'));
          return Promise.resolve({
            childId: 'kid-gate-ok',
            result: Promise.resolve({
              structured: { pass: true, reason: '重试后判定通过' },
              output: [{ type: 'text', text: '' }],
              stopReason: 'completed',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'out:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };

  // Case A: Downstream Lead exists -> skips all branch subagents (never guesses false!), jumps to Lead with failure notice
  const withLead = {
    task: '条件节点崩溃测试',
    nodes: [
      { id: 'run', kind: 'agent', label: '执行', role: '执行' },
      { id: 'gate', kind: 'condition', label: '是否通过', role: '判断' },
      { id: 'yes_s', kind: 'agent', label: '发布', role: '发布' },
      { id: 'no_s', kind: 'agent', label: '回滚', role: '回滚' },
      { id: 'final', kind: 'lead', label: 'Lead 终审', role: '终审' },
    ],
    edges: [
      { from: 'lead', to: 'run', type: 'prompt' },
      { from: 'run', to: 'gate', type: 'prompt' },
      { from: 'gate', to: 'yes_s', type: 'prompt', branch: 'true' },
      { from: 'gate', to: 'no_s', type: 'prompt', branch: 'false' },
      { from: 'yes_s', to: 'final', type: 'prompt' },
      { from: 'no_s', to: 'final', type: 'prompt' },
    ],
  };
  const sidA = 's-cond-crash-lead';
  const rFailLead = await executePlan(scope, withLead, {}, { agent: { id: sidA }, signal: new AbortController().signal });
  assert.equal(rFailLead.status, 'done');
  assert.deepEqual(spawned, ['run', 'gate'], 'neither yes_s nor no_s may run when condition node crashed');
  assert.equal(rFailLead.failed.length, 1);
  assert.equal(rFailLead.failed[0].id, 'gate');
  assert.equal(rFailLead.decisions[0].failed, true);
  assert.equal(rFailLead.finalLead.label, 'Lead 终审');
  assert.ok(rFailLead.hint.includes('自身执行失败') && rFailLead.hint.includes('retryFailed'));

  // Retry failed -> reuses 'run' from cache, re-runs only 'gate' and the newly chosen 'yes_s'!
  spawned.length = 0;
  crashGate = false;
  const rRecovered = await executePlan(scope, withLead, { retryFailed: true }, { agent: { id: sidA }, signal: new AbortController().signal });
  assert.equal(rRecovered.status, 'done');
  assert.deepEqual(spawned, ['gate', 'yes_s'], 'reuses upstream run and executes winning branch');
  assert.deepEqual(rRecovered.reused, ['执行']);
  assert.deepEqual(rRecovered.branchSkipped, ['回滚']);

  // Case B: No downstream Lead -> halts cleanly instead of guessing a branch
  const noLead = {
    task: '无 Lead 条件崩溃测试',
    nodes: [
      { id: 'run', kind: 'agent', label: '执行', role: '执行' },
      { id: 'gate', kind: 'condition', label: '是否通过', role: '判断' },
      { id: 'yes_s', kind: 'agent', label: '发布', role: '发布' },
      { id: 'no_s', kind: 'agent', label: '回滚', role: '回滚' },
    ],
    edges: [
      { from: 'lead', to: 'run', type: 'prompt' },
      { from: 'run', to: 'gate', type: 'prompt' },
      { from: 'gate', to: 'yes_s', type: 'prompt', branch: 'true' },
      { from: 'gate', to: 'no_s', type: 'prompt', branch: 'false' },
    ],
  };
  spawned.length = 0;
  crashGate = true;
  const rHalted = await executePlan(scope, noLead, {}, { agent: { id: 's-cond-crash-nolead' }, signal: new AbortController().signal });
  assert.equal(rHalted.status, 'halted');
  assert.deepEqual(spawned, ['run', 'gate']);
  assert.ok(rHalted.error.includes('自身执行失败') && rHalted.error.includes('retryFailed'));
});

test('executePlan publishes live run-state telemetry (.run.json) with condition verdicts and pruned nodes', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wc-runstate-'));
  try {
    const sid = 's-runstate-telemetry';
    const scope = {
      sessions: {
        get(id) {
          return id === sid ? { header: { cwd: dir } } : null;
        },
      },
      subagents: {
        startActivation(spec) {
          const id = spec.label.split('#')[1];
          if (id === 'gate') {
            return Promise.resolve({
              childId: 'kid-gate',
              result: Promise.resolve({
                status: 'completed',
                structured: { branches: ['minor'], reason: '仅两处小修，无需重写' },
                finalText: '',
              }),
            });
          }
          return Promise.resolve({
            childId: 'kid-' + id,
            result: Promise.resolve({ status: 'completed', finalText: 'done-' + id }),
          });
        },
      },
    };
    const plan = {
      task: 'telemetry test',
      nodes: [
        { id: 'scan', kind: 'agent', label: '扫描', role: '扫描' },
        {
          id: 'gate',
          kind: 'condition',
          label: '分级',
          role: '按严重度分级',
          branches: [
            { id: 'minor', label: '小修' },
            { id: 'rewrite', label: '重写' },
          ],
        },
        { id: 'fix', kind: 'agent', label: '小修执行', role: '小修' },
        { id: 'redo', kind: 'agent', label: '重写执行', role: '重写' },
      ],
      edges: [
        { from: 'lead', to: 'scan', type: 'prompt' },
        { from: 'scan', to: 'gate', type: 'prompt' },
        { from: 'gate', to: 'fix', type: 'prompt', branch: 'minor' },
        { from: 'gate', to: 'redo', type: 'prompt', branch: 'rewrite' },
      ],
    };
    const res = await executePlan(scope, plan, {}, { agent: { id: sid }, signal: new AbortController().signal });
    assert.equal(res.status, 'done');
    const runFile = JSON.parse(readFileSync(join(dir, '.dsh', 'canvas', sid + '.run.json'), 'utf8'));
    assert.equal(runFile.status, 'done');
    assert.deepEqual(runFile.decisions.gate.branchLabels, ['小修']);
    assert.equal(runFile.decisions.gate.reason, '仅两处小修，无需重写');
    assert.deepEqual(runFile.pruned, ['redo']);
    assert.ok(runFile.blockedEdges.some((k) => k.startsWith('gate->redo|')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('briefFor, normalizeCanvas, and applyPatch inject and preserve global and per-node refs', () => {
  const gen = normalizeCanvas({
    task: '代码审查',
    refs: ['README.md', '  README.md  ', 'docs/api.md'],
    nodes: [
      { ref: 'a1', kind: 'agent', label: '审查模块', role: '只读排查', refs: ['src/index.js', 'README.md'] },
    ],
    edges: [{ from: 'lead', to: 'a1', type: 'prompt' }],
  });
  assert.ok(!gen.error);
  const entry = gen.nodes.find((n) => n.id === 'lead');
  assert.deepEqual(entry.refs, ['README.md', 'docs/api.md']);
  const aNode = gen.nodes.find((n) => n.id !== 'lead');
  assert.deepEqual(aNode.refs, ['src/index.js', 'README.md']);

  const prompt = briefFor(
    { task: '代码审查', refs: entry.refs, nodes: withoutEntry(gen.nodes), edges: gen.edges },
    aNode,
    {},
  );
  assert.ok(prompt.includes('【参考资料 / 约束】'));
  assert.ok(prompt.includes('- README.md'));
  assert.ok(prompt.includes('- docs/api.md'));
  assert.ok(prompt.includes('- src/index.js'));
  assert.equal(prompt.match(/README\.md/g).length, 1, 'duplicate refs must be deduplicated');

  const patched = applyPatch(
    { task: '代码审查', refs: entry.refs, nodes: withoutEntry(gen.nodes), edges: gen.edges },
    {
      refs: ['docs/new.md'],
      nodes: [{ id: aNode.id, refs: ['src/client.js'] }],
    },
  );
  assert.equal(patched.refsPatched, true);
  assert.deepEqual(patched.plan.refs, ['docs/new.md']);
  assert.deepEqual(patched.plan.nodes[0].refs, ['src/client.js']);
});

test('Lead -> Lead stage chains execute with zero subagents and pass leadResult downstream', async () => {
  const spawned = [];
  const briefs = {};
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        spawned.push(id);
        briefs[id] = (spec.prompt && spec.prompt[0] && spec.prompt[0].text) || '';
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'done:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };

  // Pure Lead -> Lead -> Lead main-conversation stage chain (0 subagents)
  const stageNodes = [
    { id: 'lead', kind: 'lead', label: 'Lead' },
    { id: 'l1', kind: 'lead', label: '方案起草', role: '在主对话起草方案并与用户确认', refs: ['docs/spec.md'] },
    { id: 'l2', kind: 'lead', label: '最终交付', role: '总结变更并给出发布指令' },
  ];
  const stageEdges = [
    { from: 'lead', to: 'l1', type: 'prompt' },
    { from: 'l1', to: 'l2', type: 'prompt' },
  ];
  assert.deepEqual(analyzeCanvasWarnings(stageNodes, stageEdges), []);

  const plan = { task: '重构配置模块', nodes: withoutEntry(stageNodes), edges: stageEdges };
  const sid = 's-lead-stages-' + Date.now();
  const r1 = await executePlan(scope, plan, {}, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(r1.status, 'need-lead');
  assert.equal(r1.node.label, '方案起草');
  assert.equal(r1.node.role, '在主对话起草方案并与用户确认');
  assert.deepEqual(r1.node.refs, ['docs/spec.md']);
  assert.equal(spawned.length, 0);

  const r2 = await executePlan(scope, plan, { leadResult: '已确认采用方案 B' }, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(r2.status, 'done');
  assert.equal(r2.finalLead.label, '最终交付');
  assert.equal(r2.finalLead.role, '总结变更并给出发布指令');
  assert.equal(r2.results.l1, '已确认采用方案 B');
  assert.equal(spawned.length, 0, 'pure Lead chain never spawns subagents');

  // Lead -> Lead(stage) -> Subagent passes leadResult into downstream subagent brief
  const mixNodes = [
    { id: 'lead', kind: 'lead', label: 'Lead' },
    { id: 'pre', kind: 'lead', label: '主对话调研', role: '先和用户明确边界' },
    { id: 'impl', kind: 'agent', label: '实现', role: '按确认的边界写代码' },
  ];
  const mixEdges = [
    { from: 'lead', to: 'pre', type: 'prompt' },
    { from: 'pre', to: 'impl', type: 'prompt' },
  ];
  const mixPlan = { task: '新增主题切换', nodes: withoutEntry(mixNodes), edges: mixEdges };
  const sid2 = 's-lead-to-agent-' + Date.now();
  const m1 = await executePlan(scope, mixPlan, {}, { agent: { id: sid2 }, signal: new AbortController().signal });
  assert.equal(m1.status, 'need-lead');
  assert.equal(m1.node.label, '主对话调研');
  assert.equal(spawned.length, 0);

  const m2 = await executePlan(scope, mixPlan, { leadResult: '仅保留深浅双色，不做自定义配色' }, { agent: { id: sid2 }, signal: new AbortController().signal });
  assert.equal(m2.status, 'done');
  assert.deepEqual(spawned, ['impl']);
  assert.ok(briefs.impl.includes('仅保留深浅双色，不做自定义配色'));
});

test('controlled loop retries with feedback & warm session reuse, isolates bypass nodes, and exits on pass', async () => {
  const calls = [];
  let codeRound = 0;
  let checkRound = 0;
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        const prompt = (spec.prompt && spec.prompt[0] && spec.prompt[0].text) || '';
        calls.push({ id, childId: spec.childId || null, prompt });
        if (id === 'code') {
          codeRound += 1;
          return Promise.resolve({
            childId: spec.childId || ('kid-code-' + codeRound),
            result: Promise.resolve({ output: [{ type: 'text', text: 'code-v' + codeRound }], stopReason: 'completed' }),
            dispose: () => Promise.resolve(),
          });
        }
        if (id === 'check') {
          checkRound += 1;
          const decision = checkRound === 1
            ? { pass: false, reason: 'auth.js 缺少空值校验' }
            : { pass: true, reason: '所有单测通过' };
          return Promise.resolve({
            childId: 'kid-check-' + checkRound,
            result: Promise.resolve({ structured: decision, output: [{ type: 'text', text: JSON.stringify(decision) }], stopReason: 'completed' }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };

  const nodes = [
    { id: 'lead', kind: 'lead', label: 'Lead' },
    { id: 'code', kind: 'agent', label: '编写代码', role: '实现登录接口' },
    { id: 'test', kind: 'agent', label: '跑单测', role: '执行测试套件' },
    { id: 'check', kind: 'condition', label: '是否通过？', role: '全部通过走是，否则走否' },
    { id: 'docs', kind: 'agent', label: '旁路文档', role: '补充说明文档' },
    { id: 'ship', kind: 'agent', label: '交付汇总', role: '整理发布清单' },
  ];
  const edges = [
    { from: 'lead', to: 'code', type: 'prompt' },
    { from: 'lead', to: 'docs', type: 'prompt' },
    { from: 'code', to: 'test', type: 'prompt' },
    { from: 'test', to: 'check', type: 'prompt' },
    { from: 'check', to: 'ship', type: 'prompt', branch: 'true' },
    { from: 'check', to: 'code', type: 'prompt', branch: 'false', loop: true, maxIterations: 3 },
    { from: 'docs', to: 'ship', type: 'prompt' },
  ];
  assert.deepEqual(validateLoopEdges(nodes, edges), []);
  assert.deepEqual(Array.from(loopMemberIds(nodes, edges, edges[5])).sort(), ['check', 'code', 'test']);

  const plan = { task: '上线登录功能', nodes: withoutEntry(nodes), edges };
  const res = await executePlan(scope, plan, {}, { agent: { id: 's-loop-pass-' + Date.now() }, signal: new AbortController().signal });
  assert.equal(res.status, 'done');
  assert.equal(res.loopExhausted, undefined);
  assert.equal(calls.filter((c) => c.id === 'docs').length, 1, 'bypass node outside loop runs only once');
  assert.equal(calls.filter((c) => c.id === 'ship').length, 1, 'downstream ship runs once after loop exits');
  const codeCalls = calls.filter((c) => c.id === 'code');
  assert.equal(codeCalls.length, 2, 'code ran initial + 1 retry');
  assert.equal(codeCalls[0].childId, null);
  assert.equal(codeCalls[1].childId, 'kid-code-1', 'retry reuses healthy warm session');
  assert.ok(codeCalls[1].prompt.includes('auth.js 缺少空值校验'), 'retry prompt carries condition feedback');
  assert.ok(codeCalls[1].prompt.includes('1/3'), 'retry prompt carries round ratio');
});

test('loop exhaustion stops at maxIterations, drops crashed warm session, and hands off history to Lead', async () => {
  const calls = [];
  let codeRound = 0;
  let checkRound = 0;
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        const prompt = (spec.prompt && spec.prompt[0] && spec.prompt[0].text) || '';
        calls.push({ id, childId: spec.childId || null, prompt });
        if (id === 'code') {
          codeRound += 1;
          // Round 1 crashes so round 2 must NOT reuse its crashed child session
          const crashed = codeRound === 1;
          return Promise.resolve({
            childId: 'kid-c-' + codeRound,
            result: Promise.resolve({ output: [{ type: 'text', text: crashed ? 'boom' : 'attempt-' + codeRound }], stopReason: crashed ? 'error' : 'completed' }),
            dispose: () => Promise.resolve(),
          });
        }
        checkRound += 1;
        const dec = { pass: false, reason: '失败原因#' + checkRound };
        return Promise.resolve({
          childId: 'kid-j-' + checkRound,
          result: Promise.resolve({ structured: dec, output: [{ type: 'text', text: JSON.stringify(dec) }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const nodes = [
    { id: 'lead', kind: 'lead', label: 'Lead' },
    { id: 'code', kind: 'agent', label: '实现', role: '写代码' },
    { id: 'check', kind: 'condition', label: '验收？', role: '是否通过' },
    { id: 'final', kind: 'lead', label: '终审拍板', role: '决定如何收尾' },
  ];
  const edges = [
    { from: 'lead', to: 'code', type: 'prompt' },
    { from: 'code', to: 'check', type: 'prompt' },
    { from: 'check', to: 'final', type: 'prompt', branch: 'true' },
    { from: 'check', to: 'code', type: 'prompt', branch: 'false', loop: true, maxIterations: 2 },
  ];
  const plan = { task: '修 bug', nodes: withoutEntry(nodes), edges };
  const res = await executePlan(scope, plan, {}, { agent: { id: 's-loop-ex-' + Date.now() }, signal: new AbortController().signal });
  assert.equal(res.status, 'done');
  assert.equal(res.finalLead.label, '终审拍板');
  const codeCalls = calls.filter((c) => c.id === 'code');
  assert.equal(codeCalls.length, 3, 'initial + 2 retries = 3 total runs, never spawns a 4th');
  assert.equal(codeCalls[1].childId, null, 'crashed round 1 session is NOT reused');
  assert.equal(codeCalls[2].childId, 'kid-c-2', 'healthy round 2 session IS reused on round 3');
  assert.equal(res.loopExhausted.length, 1);
  assert.equal(res.loopExhausted[0].iterations, 2);
  assert.equal(res.loopExhausted[0].history.length, 3);
  assert.ok(res.hint.includes('失败原因#1') && res.hint.includes('失败原因#3'), 'Lead hint summarizes every failed round');
});

test('loop targeting a Lead passes loopFeedback via need-lead and crossing loops are rejected', async () => {
  let judgeCount = 0;
  const scope = {
    subagents: {
      startActivation() {
        judgeCount += 1;
        const dec = judgeCount === 1
          ? { pass: false, reason: '方案缺少回滚步骤' }
          : { pass: true, reason: '方案完整' };
        return Promise.resolve({
          childId: 'kid-jl-' + judgeCount,
          result: Promise.resolve({ structured: dec, output: [{ type: 'text', text: JSON.stringify(dec) }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const nodes = [
    { id: 'lead', kind: 'lead', label: 'Lead' },
    { id: 'draft', kind: 'lead', label: '主对话起草', role: '撰写迁移方案' },
    { id: 'judge', kind: 'condition', label: '方案完备？', role: '检查是否含回滚步骤' },
    { id: 'end', kind: 'lead', label: '最终确认', role: '批准发布' },
  ];
  const edges = [
    { from: 'lead', to: 'draft', type: 'prompt' },
    { from: 'draft', to: 'judge', type: 'prompt' },
    { from: 'judge', to: 'end', type: 'prompt', branch: 'true' },
    { from: 'judge', to: 'draft', type: 'prompt', branch: 'false', loop: true, maxIterations: 2 },
  ];
  const plan = { task: '数据库迁移', nodes: withoutEntry(nodes), edges };
  const sid = 's-loop-lead-' + Date.now();
  const r1 = await executePlan(scope, plan, {}, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(r1.status, 'need-lead');
  assert.equal(r1.node.label, '主对话起草');
  assert.equal(r1.node.loopFeedback, undefined);

  const r2 = await executePlan(scope, plan, { leadResult: '初版方案（无回滚）' }, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(r2.status, 'need-lead');
  assert.equal(r2.node.label, '主对话起草');
  assert.equal(r2.node.loopFeedback.retry, 1);
  assert.equal(r2.node.loopFeedback.reason, '方案缺少回滚步骤');
  assert.ok(r2.hint.includes('方案缺少回滚步骤'));

  const r3 = await executePlan(scope, plan, { leadResult: '修订方案（含回滚）' }, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(r3.status, 'done');
  assert.equal(r3.finalLead.label, '最终确认');

  // Crossing loops are rejected by validateLoopEdges & normalizeCanvas/applyPatch preserve loop metadata
  const crossNodes = [
    { id: 'a', kind: 'agent' },
    { id: 'b', kind: 'agent' },
    { id: 'c1', kind: 'condition' },
    { id: 'c2', kind: 'condition' },
  ];
  const crossEdges = [
    { from: 'lead', to: 'a' },
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c1' },
    { from: 'c1', to: 'c2' },
    { from: 'c1', to: 'a', branch: 'false', loop: true, maxIterations: 2 },
    { from: 'c2', to: 'b', branch: 'false', loop: true, maxIterations: 2 },
  ];
  assert.ok(validateLoopEdges(crossNodes, crossEdges).some((e) => e.includes('交叉')));

  const gen = normalizeCanvas({
    task: 't',
    nodes: [{ ref: 'a', label: 'A' }, { ref: 'c', kind: 'condition', label: 'C' }],
    edges: [
      { from: 'lead', to: 'a' },
      { from: 'a', to: 'c' },
      { from: 'c', to: 'a', branch: 'false', loop: true, maxIterations: 5 },
    ],
  });
  const le = gen.edges.find((e) => e.loop);
  assert.ok(le && le.maxIterations === 5);
  const patched = applyPatch({ task: 't', nodes: withoutEntry(gen.nodes), edges: gen.edges }, {
    edges: [{ from: le.from, to: le.to, branch: 'false', loop: true, maxIterations: 7 }],
  });
  assert.equal(patched.plan.edges.find((e) => e.loop).maxIterations, 7);

  // Mid-loop bypass leak warning
  const leakNodes = [
    { id: 'lead', kind: 'lead', label: 'Lead' },
    { id: 'a', kind: 'agent', label: '编码' },
    { id: 'b', kind: 'condition', label: '验收' },
    { id: 'side', kind: 'agent', label: '旁路' },
    { id: 'end', kind: 'lead', label: '终审', role: '汇总' },
  ];
  const leakEdges = [
    { from: 'lead', to: 'a' },
    { from: 'a', to: 'b' },
    { from: 'a', to: 'side' },
    { from: 'side', to: 'end' },
    { from: 'b', to: 'end', branch: 'true' },
    { from: 'b', to: 'a', branch: 'false', loop: true, maxIterations: 2 },
  ];
  const leakWarns = analyzeCanvasWarnings(leakNodes, leakEdges);
  assert.ok(leakWarns.some((w) => w.includes('绕过条件裁判的旁路连线') && w.includes('编码 → 旁路')));
});

test('abortSessionRun & cancel:true cleanly end waitingLead pause (#13) and instantly abort hanging subagents (#11)', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wc-stop-'));
  try {
    // Part A (#13): Pause at intermediate Lead, then cancel via executePlan({ cancel: true }) / abortSessionRun
    const sidPause = 's-stop-waiting-' + Date.now();
    const scopePause = {
      sessions: {
        get(id) { return id === sidPause ? { header: { cwd: dir } } : null; },
      },
      subagents: {
        startActivation(spec) {
          const id = spec.label.split('#')[1];
          return Promise.resolve({
            childId: 'kid-' + id,
            result: Promise.resolve({ output: [{ type: 'text', text: 'out:' + id }], stopReason: 'completed' }),
            dispose: () => Promise.resolve(),
          });
        },
      },
    };
    const pausePlan = {
      task: '拍板后取消测试',
      nodes: [
        { id: 'a', kind: 'agent', label: '调研', role: '调研' },
        { id: 'gate', kind: 'lead', label: 'Lead 拍板', role: '人工决策' },
        { id: 'b', kind: 'agent', label: '执行', role: '执行' },
      ],
      edges: [
        { from: 'lead', to: 'a', type: 'prompt' },
        { from: 'a', to: 'gate', type: 'prompt' },
        { from: 'gate', to: 'b', type: 'prompt' },
      ],
    };
    const rPause = await executePlan(scopePause, pausePlan, {}, { agent: { id: sidPause }, signal: new AbortController().signal });
    assert.equal(rPause.status, 'need-lead');
    const pausedRunFile = JSON.parse(readFileSync(join(dir, '.dsh', 'canvas', sidPause + '.run.json'), 'utf8'));
    assert.equal(pausedRunFile.status, 'need-lead');
    assert.equal(pausedRunFile.waitingLead.id, 'gate');

    const rCancel = await executePlan(scopePause, pausePlan, { cancel: true }, { agent: { id: sidPause }, signal: new AbortController().signal });
    assert.equal(rCancel.status, 'cancelled');
    assert.equal(rCancel.wasWaiting, true);
    const haltedRunFile = JSON.parse(readFileSync(join(dir, '.dsh', 'canvas', sidPause + '.run.json'), 'utf8'));
    assert.equal(haltedRunFile.status, 'halted');
    assert.equal(haltedRunFile.waitingLead, null);

    // After cancelling waitingLead, starting a fresh run works cleanly (no stale waitingLead lock)
    const rFresh = await executePlan(scopePause, pausePlan, {}, { agent: { id: sidPause }, signal: new AbortController().signal });
    assert.equal(rFresh.status, 'need-lead');
    abortSessionRun(scopePause, sidPause);

    // Part B (#11): Active subagent that never resolves on its own -> abortSessionRun aborts signal,
    // invokes DSH native subagents.interrupt(childId, { kind: 'user' }), drainDescendants([rootAgent]),
    // rootAgent.cancel({ kind: 'user' }, { keepInbox: true }), and unblocks executePlan immediately!
    const sidRun = 's-stop-running-' + Date.now();
    const interruptedChildren = [];
    let drainedAgents = null;
    let rootCancelArgs = null;
    let observedSignalAborted = false;
    let startedResolve;
    const started = new Promise((r) => { startedResolve = r; });
    const mockRootAgent = {
      id: sidRun,
      running: true,
      cancel(cause, options) { rootCancelArgs = { cause, options }; },
    };
    const scopeRun = {
      sessions: {
        get(id) { return id === sidRun ? { header: { cwd: dir } } : null; },
      },
      subagents: {
        interrupt(cid, authority) { interruptedChildren.push({ cid, authority }); },
        drainDescendants(agents) { drainedAgents = agents; return Promise.resolve(); },
        startActivation(spec) {
          spec.signal.addEventListener('abort', () => { observedSignalAborted = true; }, { once: true });
          startedResolve();
          return Promise.resolve({
            childId: 'kid-slow',
            // Deliberately never resolves to prove abortPromise unblocks executePlan immediately
            result: new Promise(() => {}),
            dispose: () => Promise.resolve(),
          });
        },
      },
    };
    const slowPlan = {
      task: '运行中一键终止测试',
      nodes: [{ id: 'slow', kind: 'agent', label: '慢节点', role: '慢任务' }],
      edges: [{ from: 'lead', to: 'slow', type: 'prompt' }],
    };
    const runPromise = executePlan(scopeRun, slowPlan, {}, { agent: mockRootAgent, signal: new AbortController().signal });
    await started;
    const stopRes = abortSessionRun(scopeRun, sidRun, mockRootAgent);
    assert.equal(stopRes.wasRunning, true);
    const abortedOut = await runPromise;
    assert.equal(abortedOut.status, 'halted');
    assert.ok(abortedOut.error.includes('已取消'));
    assert.equal(observedSignalAborted, true, 'runSignal aborts in-flight subagent spec.signal');
    assert.deepEqual(interruptedChildren, [{ cid: 'kid-slow', authority: { kind: 'user' } }], 'calls DSH subagents.interrupt with user authority');
    assert.deepEqual(drainedAgents, [mockRootAgent], 'calls DSH subagents.drainDescendants on root agent');
    assert.deepEqual(rootCancelArgs, { cause: { kind: 'user' }, options: { keepInbox: true } }, 'calls rootAgent.cancel with verified signature');
    const stoppedRunFile = JSON.parse(readFileSync(join(dir, '.dsh', 'canvas', sidRun + '.run.json'), 'utf8'));
    assert.equal(stoppedRunFile.status, 'halted');
    assert.equal(stoppedRunFile.waitingLead, null);

    // Part C: `/canvas-stop` command is registered by apply(ctx) and succeeds
    const commands = new Map();
    const mockCtx = {
      inject(deps, fn) {
        if (deps.includes('commands')) {
          fn({
            effect(cb) { cb(); },
            commands: { register(cmd) { commands.set(cmd.name, cmd); } },
          });
        }
      },
    };
    apply(mockCtx);
    assert.ok(commands.has('canvas-stop'), 'registers /canvas-stop command');
    const cmdRes = commands.get('canvas-stop').handler({ agent: { id: sidPause } });
    assert.equal(cmdRes.kind, 'success');

    // Part D: Parent AbortSignal (DSH native chat Stop) interrupts live children AND suppresses fallbackModel retry
    const sidNative = 's-native-stop-' + Date.now();
    const nativeInterrupts = [];
    let spawnCount = 0;
    let resolveStart;
    const startedNative = new Promise((r) => { resolveStart = r; });
    const parentCtrl = new AbortController();
    const scopeNative = {
      sessions: { get: () => null },
      subagents: {
        interrupt(cid, authority) { nativeInterrupts.push({ cid, authority }); },
        startActivation(spec) {
          spawnCount += 1;
          resolveStart();
          return Promise.resolve({
            childId: 'kid-fb-1',
            result: new Promise((res) => {
              spec.signal.addEventListener('abort', () => {
                res({ output: [{ type: 'text', text: '' }], stopReason: 'cancelled' });
              }, { once: true });
            }),
            dispose: () => Promise.resolve(),
          });
        },
      },
    };
    const fbPlan = {
      task: '原生停止不触发备用模型重试',
      nodes: [{ id: 'n1', kind: 'agent', label: '编码', role: '编码', fallbackModel: 'backup-m' }],
      edges: [{ from: 'lead', to: 'n1', type: 'prompt' }],
    };
    const nativePromise = executePlan(scopeNative, fbPlan, {}, { agent: { id: sidNative }, signal: parentCtrl.signal });
    await startedNative;
    parentCtrl.abort('user-native-stop');
    const nativeOut = await nativePromise;
    assert.equal(nativeOut.status, 'halted');
    assert.deepEqual(nativeInterrupts, [{ cid: 'kid-fb-1', authority: { kind: 'user' } }], 'native parent AbortSignal interrupts live children');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(spawnCount, 1, 'aborted node must NEVER spawn its fallbackModel retry');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent strong context, canvas_inspect render, and Lead render reflect loops, refs, and cancel', async () => {
  const tools = new Map();
  const commands = new Map();
  const mockCtx = {
    inject(deps, fn) {
      const fakeScope = {
        effect(cb) { cb(); },
        commands: { register(c) { commands.set(c.name, c); } },
        tools: { register(t) { tools.set(t.name, t); } },
        subagents: {
          startActivation(spec) {
            const id = spec.label.split('#')[1];
            return Promise.resolve({
              childId: 'kid-' + id,
              result: Promise.resolve({ output: [{ type: 'text', text: 'ok:' + id }], stopReason: 'completed' }),
              dispose: () => Promise.resolve(),
            });
          },
        },
        sessions: { get: () => null },
      };
      if (deps.includes('commands') || deps.includes('tools')) fn(fakeScope);
    },
  };
  apply(mockCtx);

  const sid = 's-ctx-sync-' + Date.now();
  const plan = {
    task: '带参考与回环的强注入测试',
    refs: ['docs/spec.md'],
    nodes: [
      { id: 'draft', kind: 'agent', label: '实现', role: '编码' },
      { id: 'gate', kind: 'condition', label: '是否通过', role: '检查' },
      { id: 'mid', kind: 'lead', label: '人工拍板', role: '确认', refs: ['docs/review.md'] },
      { id: 'final', kind: 'lead', label: '终审', role: '交付', refs: ['docs/ship.md'] },
    ],
    edges: [
      { from: 'lead', to: 'draft', type: 'prompt' },
      { from: 'draft', to: 'gate', type: 'prompt' },
      { from: 'gate', to: 'mid', type: 'prompt', branch: 'true' },
      { from: 'gate', to: 'draft', type: 'prompt', branch: 'false', loop: true, maxIterations: 4 },
      { from: 'mid', to: 'final', type: 'prompt' },
    ],
  };
  commands.get('canvas-sync').handler({
    agent: { id: sid },
    rawInput: encodeURIComponent(JSON.stringify({ enabled: true, plan })),
  });

  // 1) Active systemPrompt strong context reflects loops + global refs + edit guidance
  const activeCtx = buildActiveCanvasContext(sid);
  assert.ok(activeCtx.includes('1 条受控回环'), 'active context informs agent of controlled loops');
  assert.ok(activeCtx.includes('全局参考 ×1'), 'active context informs agent of global refs');
  assert.ok(activeCtx.includes('参考清单、条件分支、回环'), 'active context includes new edit items');

  // 2) canvas_inspect render shows global refs and loop edge badge
  const inspectVal = tools.get('canvas_inspect').execute({}, { agent: { id: sid } });
  const inspectText = tools.get('canvas_inspect').output.render({}, inspectVal)[0].text;
  assert.ok(inspectText.includes('全局参考：docs/spec.md'), 'canvas_inspect render prints global refs');
  assert.ok(inspectText.includes('↺ loop ×4'), 'canvas_inspect render prints loop edge & maxIterations');

  // 3) Lead steps receive merged global + node refs in rendered tool output & cancel hint
  const wfTool = tools.get('canvas_workflow');
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        if (id === 'gate') {
          return Promise.resolve({
            childId: 'kid-gate',
            result: Promise.resolve({ structured: { pass: true, reason: '通过' }, output: [{ type: 'text', text: '' }], stopReason: 'completed' }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'out:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const rMid = await executePlan(scope, plan, {}, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(rMid.status, 'need-lead');
  const midRendered = wfTool.output.render({}, rMid)[0].text;
  assert.ok(midRendered.includes('docs/spec.md') && midRendered.includes('docs/review.md'), 'need-lead render displays merged global + node refs');
  assert.ok(midRendered.includes('cancel: true'), 'need-lead hint mentions cancel: true');

  const pausedCtx = buildActiveCanvasContext(sid);
  assert.ok(pausedCtx.includes('cancel: true'), 'paused strong context mentions cancel: true');

  const rFinal = await executePlan(scope, plan, { leadResult: '放行' }, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(rFinal.status, 'done');
  const finalRendered = wfTool.output.render({}, rFinal)[0].text;
  assert.ok(finalRendered.includes('docs/spec.md') && finalRendered.includes('docs/ship.md'), 'finalLead render displays merged global + node refs');

  // 4) Condition nodes always stay `minimal` and never trigger false multi-standard permission warnings
  const condOnlyGen = normalizeCanvas({
    task: '条件只读测试',
    nodes: [
      { id: 'c1', kind: 'condition', label: '判断1', role: 'r1' },
      { id: 'c2', kind: 'condition', label: '判断2', role: 'r2' },
    ],
    edges: [{ from: 'lead', to: 'c1' }, { from: 'c1', to: 'c2', branch: 'true' }],
  });
  assert.equal(condOnlyGen.nodes.find((n) => n.id === 'c1').preset, 'minimal');
  const patchedCond = applyPatch({ task: 't', nodes: withoutEntry(condOnlyGen.nodes), edges: condOnlyGen.edges }, {
    nodes: [{ id: 'c3', kind: 'condition', label: '判断3', role: 'r3' }],
  });
  assert.equal(patchedCond.plan.nodes.find((n) => n.id === 'c3').preset, 'minimal');
  const sidCondOnly = 's-cond-minimal-' + Date.now();
  commands.get('canvas-sync').handler({
    agent: { id: sidCondOnly },
    rawInput: encodeURIComponent(JSON.stringify({ enabled: true, plan: patchedCond.plan })),
  });
  assert.ok(!buildActiveCanvasContext(sidCondOnly).includes('可写/命令型'), 'read-only condition nodes must not trigger standard permission warning');
});

test('loop retry un-prunes outside branch pruned by an inner condition on round 1', async () => {
  let innerRound = 0;
  let outerRound = 0;
  const spawned = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        spawned.push(id);
        if (id === 'c_in') {
          innerRound += 1;
          // Round 1 picks `work` (pruning `alt_exit`); round 2 picks `alt_exit`!
          return Promise.resolve({
            childId: 'kid-cin-' + innerRound,
            result: Promise.resolve({
              structured: { pass: innerRound === 1, reason: innerRound === 1 ? '先走主路' : '改走备路' },
              output: [{ type: 'text', text: '' }],
              stopReason: 'completed',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        if (id === 'c_out') {
          outerRound += 1;
          return Promise.resolve({
            childId: 'kid-cout-' + outerRound,
            result: Promise.resolve({
              structured: { pass: false, reason: '第1轮失败，回环重来' },
              output: [{ type: 'text', text: '' }],
              stopReason: 'completed',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-' + id + '-' + spawned.length,
          result: Promise.resolve({ output: [{ type: 'text', text: 'out:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const plan = {
    task: '环内分支解剪测试',
    nodes: [
      { id: 'start', kind: 'agent', label: '准备', role: '准备' },
      { id: 'c_in', kind: 'condition', label: '选路', role: '选路' },
      { id: 'work', kind: 'agent', label: '主路', role: '主路' },
      { id: 'c_out', kind: 'condition', label: '验收', role: '验收' },
      { id: 'alt_exit', kind: 'agent', label: '备路出口', role: '备路' },
      { id: 'final', kind: 'lead', label: '终审', role: '终审' },
    ],
    edges: [
      { from: 'lead', to: 'start', type: 'prompt' },
      { from: 'start', to: 'c_in', type: 'prompt' },
      { from: 'c_in', to: 'work', type: 'prompt', branch: 'true' },
      { from: 'c_in', to: 'alt_exit', type: 'prompt', branch: 'false' },
      { from: 'work', to: 'c_out', type: 'prompt' },
      { from: 'c_out', to: 'final', type: 'prompt', branch: 'true' },
      { from: 'c_out', to: 'start', type: 'prompt', branch: 'false', loop: true, maxIterations: 3 },
      { from: 'alt_exit', to: 'final', type: 'prompt' },
    ],
  };
  const res = await executePlan(scope, plan, {}, { agent: { id: 's-loop-unprune-' + Date.now() }, signal: new AbortController().signal });
  assert.equal(res.status, 'done');
  assert.ok(spawned.includes('alt_exit'), 'outside branch pruned on round 1 must un-prune and run when chosen on round 2');
  assert.equal(res.results.alt_exit, 'out:alt_exit');
});
