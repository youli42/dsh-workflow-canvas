import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadClientTestExports() {
  let loaded = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(mod) { loaded = mod; },
      },
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
    },
    console,
    Math,
    Date,
    JSON,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Infinity,
    encodeURIComponent,
    decodeURIComponent,
  };
  const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, sandbox);
  assert.ok(loaded, 'client module registered');
  assert.equal(loaded.id, 'dsh-workflow-canvas', 'module id matches published package name');
  const mod = loaded.factory((name) => {
    if (name === 'react') {
      return {
        createElement: () => null,
        useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
        useRef: (v) => ({ current: v }),
        useEffect: () => {},
        Component: class {},
        Fragment: Symbol('Fragment'),
      };
    }
    throw new Error('unexpected require: ' + name);
  });
  return mod.__test;
}

const client = loadClientTestExports();

test('wouldCycle blocks cycles and edges pointing into entry Lead', () => {
  const nodes = [{ id: 'lead' }, { id: 'a' }, { id: 'b' }, { id: 'c' }];
  const edges = [
    { from: 'lead', to: 'a' },
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ];
  assert.equal(client.wouldCycle(nodes, edges, 'c', 'a'), true);
  assert.equal(client.wouldCycle(nodes, edges, 'a', 'lead'), true);
  assert.equal(client.wouldCycle(nodes, edges, 'a', 'a'), true);
  assert.equal(client.wouldCycle(nodes, edges, 'a', 'c'), false);
});

test('soloLeadNodeIds skips blank-role solo chained Leads while keeping role-bearing or subagent-fed Leads active', () => {
  const nodes = [
    { id: 'lead', kind: 'lead', task: 't' },
    { id: 'a1', kind: 'agent', label: 'Agent 1' },
    { id: 'a2', kind: 'agent', label: 'Agent 2' },
    { id: 'l1', kind: 'lead', label: 'Lead 1' },
    { id: 'l2', kind: 'lead', label: 'Lead 2', role: '' },
  ];
  // Solo chain l1 -> l2 with empty role and no subagent into l2: l2 is inactive/skipped
  const soloEdges = [
    { from: 'lead', to: 'a1', type: 'prompt' },
    { from: 'a1', to: 'l1', type: 'prompt' },
    { from: 'l1', to: 'l2', type: 'prompt' },
  ];
  assert.deepEqual(Array.from(client.soloLeadNodeIds(nodes, soloEdges)), ['l2']);
  const builtSolo = client.buildPlan(nodes, soloEdges);
  assert.ok(!builtSolo.error);
  assert.ok(builtSolo.plan.skipped.includes('Lead 2'));
  assert.ok(!builtSolo.plan.nodes.some((n) => n.id === 'l2'));

  // Chained Lead with non-empty role (main-conversation stage) stays active
  const stageNodes = nodes.map((n) => (n.id === 'l2' ? { ...n, role: '确认发布' } : n));
  assert.equal(client.soloLeadNodeIds(stageNodes, soloEdges).size, 0);
  const builtStage = client.buildPlan(stageNodes, soloEdges);
  assert.ok(!builtStage.error);
  assert.ok(builtStage.plan.nodes.some((n) => n.id === 'l2'));

  // Mixed chain l1 -> l2 AND a2 -> l2: l2 has a subagent upstream so it is active even without role
  const mixedEdges = [
    { from: 'lead', to: 'a1', type: 'prompt' },
    { from: 'a1', to: 'l1', type: 'prompt' },
    { from: 'l1', to: 'a2', type: 'prompt' },
    { from: 'l1', to: 'l2', type: 'prompt' },
    { from: 'a2', to: 'l2', type: 'prompt' },
  ];
  assert.equal(client.soloLeadNodeIds(nodes, mixedEdges).size, 0);
  const builtMixed = client.buildPlan(nodes, mixedEdges);
  assert.ok(!builtMixed.error);
  assert.ok(builtMixed.plan.nodes.some((n) => n.id === 'l2'));
});

test('layoutGraph lays out DAG columns cleanly without overlapping nodes', () => {
  const nodes = [
    { id: 'lead', x: 0, y: 0 },
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 0, y: 10 },
    { id: 'c', x: 0, y: 0 },
    { id: 'orphan', x: 0, y: 0 },
  ];
  const edges = [
    { from: 'lead', to: 'a' },
    { from: 'lead', to: 'b' },
    { from: 'a', to: 'c' },
    { from: 'b', to: 'c' },
  ];
  const laid = client.layoutGraph(nodes, edges);
  const byId = new Map(laid.map((n) => [n.id, n]));
  assert.ok(byId.get('lead').x < byId.get('a').x);
  assert.equal(byId.get('a').x, byId.get('b').x);
  assert.notEqual(byId.get('a').y, byId.get('b').y);
  assert.ok(byId.get('a').x < byId.get('c').x);
  assert.ok(byId.get('c').x < byId.get('orphan').x);
});

test('builtinTemplates returns valid acyclic templates and buildPlan accepts blank task', () => {
  for (const lang of ['zh', 'en']) {
    const templates = client.builtinTemplates(lang);
    assert.ok(templates.length >= 3);
    const swe = templates.find((t) => t.id === 'tpl-swe');
    assert.ok(swe, 'includes SWE delivery template in ' + lang);
    const types = new Set(swe.edges.map((e) => e.type));
    assert.ok(types.has('prompt') && types.has('structured') && types.has('session-ref'), 'SWE template showcases all 3 link types');
    const byId = new Map(swe.nodes.map((n) => [n.id, n]));
    assert.ok(byId.get('swe_scan').y > byId.get('swe_risk').y, 'scan sits on bottom channel for unobstructed session arc');
    assert.ok(byId.get('swe_impl').y > byId.get('swe_tests').y, 'impl sits on bottom channel for unobstructed session arc');
    for (const tpl of templates) {
      assert.ok(tpl.nodes.some((n) => n.id === 'lead'));
      assert.ok(client.topoOrder(tpl.nodes, tpl.edges), tpl.id + ' is acyclic');
      const built = client.buildPlan(tpl.nodes, tpl.edges);
      assert.ok(!built.error, tpl.id + ' builds cleanly even when task is blank: ' + built.error);
      assert.equal(client.deadEndNodeIds(tpl.nodes, tpl.edges).size, 0, tpl.id + ' has no dead-end warnings');
    }
    const ab = templates.find((t) => t.id === 'tpl-ab');
    assert.ok(ab && ab.nodes.some((n) => n.id === 'n_review' && n.kind === 'lead'), 'AB template ends with a terminal Lead');
  }
});

test('deadEndNodeIds warns on unlinked agents before/beside a Lead, but not on terminal agents after a Lead', () => {
  const withDeadEnd = client.deadEndNodeIds(
    [
      { id: 'lead', kind: 'lead' },
      { id: 'a', kind: 'agent' },
      { id: 'b', kind: 'agent' },
      { id: 'final', kind: 'lead' },
    ],
    [
      { from: 'lead', to: 'a' },
      { from: 'lead', to: 'b' },
      { from: 'a', to: 'final' },
    ],
  );
  assert.deepEqual(Array.from(withDeadEnd), ['b']);

  const leafAfterLead = client.deadEndNodeIds(
    [
      { id: 'lead', kind: 'lead' },
      { id: 'a', kind: 'agent' },
      { id: 'pick', kind: 'lead' },
      { id: 'exec', kind: 'agent' },
    ],
    [
      { from: 'lead', to: 'a' },
      { from: 'a', to: 'pick' },
      { from: 'pick', to: 'exec' },
    ],
  );
  assert.equal(leafAfterLead.size, 0, 'terminal agent strictly downstream of an intermediate Lead is not a dead-end');
});

test('nextEffectLevel cycles minimal -> standard -> vivid -> minimal', () => {
  assert.equal(client.nextEffectLevel('minimal'), 'standard');
  assert.equal(client.nextEffectLevel('standard'), 'vivid');
  assert.equal(client.nextEffectLevel('vivid'), 'minimal');
});

test('nextMaxParallel cycles 1 -> 2 -> 4 -> 6 -> 8 -> 1 and buildPlan carries maxParallel', () => {
  assert.equal(client.nextMaxParallel(1), 2);
  assert.equal(client.nextMaxParallel(2), 4);
  assert.equal(client.nextMaxParallel(4), 6);
  assert.equal(client.nextMaxParallel(6), 8);
  assert.equal(client.nextMaxParallel(8), 1);
  const built = client.buildPlan(
    [{ id: 'lead', kind: 'lead', task: 't' }, { id: 'a', kind: 'agent', label: 'A' }],
    [{ from: 'lead', to: 'a', type: 'prompt' }],
    { maxParallel: 6 },
  );
  assert.equal(built.plan.maxParallel, 6);
});

test('zoomAroundPoint keeps the content point under cursor pinned across rapid ticks', () => {
  const start = { k: 0.75, x: -1200, y: -1100 };
  const mx = 340;
  const my = 220;
  const worldXBefore = (mx - start.x) / start.k;
  const worldYBefore = (my - start.y) / start.k;

  // deltaY === 0 must be a no-op (must not zoom out)
  assert.equal(client.zoomAroundPoint(start, mx, my, 0, 0), start);

  // Simulate 5 rapid consecutive ticks before a React paint
  let cur = start;
  for (let i = 0; i < 5; i += 1) {
    cur = client.zoomAroundPoint(cur, mx, my, -100, 0);
  }
  assert.ok(cur.k > start.k);
  const screenXAfter = cur.x + worldXBefore * cur.k;
  const screenYAfter = cur.y + worldYBefore * cur.k;
  assert.ok(Math.abs(screenXAfter - mx) < 1e-6, 'x stays locked under cursor');
  assert.ok(Math.abs(screenYAfter - my) < 1e-6, 'y stays locked under cursor');

  // Trackpad tiny delta zooms gently rather than jumping 12%
  const gentle = client.zoomAroundPoint(start, mx, my, -6, 0);
  assert.ok(gentle.k > start.k && gentle.k < start.k * 1.02);
});

test('scrubZoom scales smoothly right/left around viewport center and stays clamped', () => {
  const start = { k: 1, x: -1600, y: -1500 };
  const cx = 400;
  const cy = 300;
  const worldX = (cx - start.x) / start.k;
  const worldY = (cy - start.y) / start.k;

  const zoomedIn = client.scrubZoom(start, cx, cy, 140);
  const zoomedOut = client.scrubZoom(start, cx, cy, -140);
  assert.ok(zoomedIn.k > 1.9 && zoomedIn.k < 2.1);
  assert.ok(zoomedOut.k > 0.45 && zoomedOut.k < 0.55);
  assert.ok(Math.abs(zoomedIn.x + worldX * zoomedIn.k - cx) < 1e-6);
  assert.ok(Math.abs(zoomedIn.y + worldY * zoomedIn.k - cy) < 1e-6);
  assert.equal(client.scrubZoom(start, cx, cy, 2000).k, 3);
  assert.equal(client.scrubZoom(start, cx, cy, -2000).k, 0.2);
});

test('vivid edge glow does not use an objectBoundingBox SVG filter (which clips horizontal edges to 0px)', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /url\(#dsh-wc-glow\)/, 'edges must not depend on an objectBoundingBox SVG filter');
  const swe = client.builtinTemplates('zh').find((t) => t.id === 'tpl-swe');
  const byId = new Map(swe.nodes.map((n) => [n.id, n]));
  const blue = swe.edges.find((e) => e.type === 'structured');
  assert.ok(blue, 'SWE template has a structured blue edge');
  const curve = client.edgeCurve(byId.get(blue.from), byId.get(blue.to), blue);
  assert.equal(curve.y1, byId.get(blue.from).y + 2000 + client.socketCenterY(1), 'structured exits Row 1');
  assert.equal(curve.y2, byId.get(blue.to).y + 2000 + client.socketCenterY(0), 'unified left input enters Row 0');
});

test('condition template, switch/case branches, edgeCurve geometry, and buildPlan preserve kind and branches', () => {
  const condTpl = client.builtinTemplates('zh').find((t) => t.id === 'tpl-cond');
  assert.ok(condTpl, 'includes conditional branching starter template');
  const condNode = condTpl.nodes.find((n) => n.kind === 'condition');
  assert.ok(condNode, 'conditional template contains a condition node');
  const trueEdge = condTpl.edges.find((e) => e.from === condNode.id && e.branch === 'true');
  const falseEdge = condTpl.edges.find((e) => e.from === condNode.id && e.branch === 'false');
  assert.ok(trueEdge && falseEdge, 'condition node has both true and false branch edges');

  const from = { x: 100, y: 100 };
  const to = { x: 400, y: 100 };
  const cTrue = client.edgeCurve(from, to, { type: 'prompt', branch: 'true' });
  const cFalse = client.edgeCurve(from, to, { type: 'prompt', branch: 'false' });
  const cSession = client.edgeCurve(from, to, { type: 'session-ref' });
  assert.equal(cTrue.y1, from.y + 2000 + 176 + 10, 'true branch exits Row 0 center (COND_ROW_H=20)');
  assert.equal(cFalse.y1, from.y + 2000 + 176 + 20 + 10, 'false branch exits Row 1 center (COND_ROW_H=20)');
  assert.equal(cTrue.y2, to.y + 2000 + client.socketCenterY(0), 'true branch enters unified input Row 0');
  assert.equal(cFalse.y2, to.y + 2000 + client.socketCenterY(0), 'false branch enters unified input Row 0');
  assert.equal(cSession.y1, from.y + 2000 + client.socketCenterY(2), 'session exits Row 2');
  assert.equal(cSession.y2, to.y + 2000 + client.socketCenterY(0), 'session enters unified input Row 0');

  const switchNode = {
    id: 'sw',
    kind: 'condition',
    label: '多路分流',
    multiMatch: true,
    x: 100,
    y: 100,
    branches: [
      { id: 'c1', label: '前端' },
      { id: 'c2', label: '后端' },
      { id: 'c3', label: '单测' },
      { id: 'c4', label: '文档' },
      { id: 'c5', label: '性能' },
      { id: 'c6', label: '安全' },
    ],
  };
  assert.equal(client.nodeHeight(switchNode), 176 + 6 * 20 + 24, '6-branch switch/case node scales smoothly past 5');
  const cRedo = client.edgeCurve(switchNode, to, { type: 'prompt', branch: 'c3' });
  assert.equal(cRedo.y1, switchNode.y + 2000 + 176 + 2 * 20 + 10, '3rd branch exits Row 2 center');

  const built = client.buildPlan(
    [
      { id: 'lead', kind: 'lead', task: 'switch test' },
      switchNode,
      { id: 'n1', kind: 'agent', label: 'A' },
    ],
    [
      { from: 'lead', to: 'sw', type: 'prompt' },
      { from: 'sw', to: 'n1', type: 'prompt', branch: 'c2' },
    ],
  );
  assert.ok(!built.error);
  const planSw = built.plan.nodes.find((n) => n.id === 'sw');
  assert.equal(planSw.kind, 'condition');
  assert.equal(planSw.branches.length, 6);
  assert.equal(planSw.multiMatch, true);
  assert.equal(built.plan.edges.find((e) => e.from === 'sw').branch, 'c2');
});

test('dropdownAlign flips to left-anchored when trigger wraps to the left edge of the pane', () => {
  const pane = { left: 100, right: 420 };
  // Trigger wrapped to left edge of row 2 (only 42px from pane left -> right-align would clip)
  assert.equal(client.dropdownAlign({ left: 110, right: 142 }, pane, 204), 'left');
  // Trigger sitting near right edge (310px from pane left -> right-align fits cleanly)
  assert.equal(client.dropdownAlign({ left: 378, right: 410 }, pane, 204), 'right');
});

test('compatibleTargetsForWire allows Lead -> Lead stage chains as well as Subagent/Condition targets', () => {
  const fromLead = client.compatibleTargetsForWire({ id: 'lead', kind: 'lead' }, 'prompt');
  assert.deepEqual({ ...fromLead }, { agent: true, lead: true, condition: true, leadBlockedReason: '' });

  const fromAgent = client.compatibleTargetsForWire({ id: 'n1', kind: 'agent' }, 'structured');
  assert.deepEqual({ ...fromAgent }, { agent: true, lead: true, condition: true, leadBlockedReason: '' });

  const fromCond = client.compatibleTargetsForWire({ id: 'c1', kind: 'condition' }, 'prompt');
  assert.deepEqual({ ...fromCond }, { agent: true, lead: true, condition: true, leadBlockedReason: '' });
});

test('conditionVerdictSummary formats matched, unmatched, and failed verdicts in zh/en', () => {
  assert.equal(client.conditionVerdictSummary(null, 'zh'), null);
  assert.deepEqual(
    { ...client.conditionVerdictSummary({ branches: ['c1', 'c2'], branchLabels: ['前端', '单测'], reason: '需同步改' }, 'zh') },
    { tone: 'ok', text: '→ 前端 · 单测' },
  );
  assert.deepEqual(
    { ...client.conditionVerdictSummary({ branches: [], branchLabels: [], fallbackLead: '终审' }, 'zh') },
    { tone: 'warn', text: '⚠ 未命中 → 终审' },
  );
  assert.deepEqual(
    { ...client.conditionVerdictSummary({ branches: [], branchLabels: [], failed: true, fallbackLead: 'Final Lead' }, 'en') },
    { tone: 'failed', text: '⚠ Judge failed → Final Lead' },
  );
});

test('entryRunButtonState covers ready, disabled (off/empty), running, and waitingLead states', () => {
  const off = client.entryRunButtonState({ enabled: false, task: 'do x', sessionRunning: false, waitingLead: null, triggering: false, lang: 'zh' });
  assert.equal(off.state, 'disabled');
  assert.equal(off.disabled, true);
  assert.ok(off.title.includes('ON'));

  const empty = client.entryRunButtonState({ enabled: true, task: '   ', sessionRunning: false, waitingLead: null, triggering: false, lang: 'en' });
  assert.equal(empty.state, 'disabled');
  assert.equal(empty.disabled, true);
  assert.ok(empty.title.includes('task'));

  const ready = client.entryRunButtonState({ enabled: true, task: 'review code', sessionRunning: false, waitingLead: null, triggering: false, lang: 'zh' });
  assert.equal(ready.state, 'ready');
  assert.equal(ready.disabled, false);
  assert.ok(ready.title.includes('retryFailed') && ready.title.includes('reset'));

  const running = client.entryRunButtonState({ enabled: true, task: 'review code', sessionRunning: true, waitingLead: null, triggering: false, lang: 'zh' });
  assert.equal(running.state, 'running');
  assert.equal(running.disabled, true);

  const waiting = client.entryRunButtonState({ enabled: true, task: 'review code', sessionRunning: false, waitingLead: { id: 'l2', label: '中审' }, triggering: false, lang: 'zh' });
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.disabled, true);
  assert.ok(waiting.title.includes('中审'));
});

test('popup surfaces do not hardcode dark hex fallbacks and explicitly inherit theme foreground color', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /#2a2b2f/i, 'C.elevated must not hardcode a dark hex fallback that breaks light themes');
  assert.match(src, /elevated:\s*'var\(--dsw-alias-bg-elevated,\s*var\(--dsw-alias-bg-popover,/, 'C.elevated chains through host surface tokens');
  assert.match(src, /menu:\s*\{[^}]*background:\s*C\.elevated,\s*color:\s*C\.text/s, 'dropdown menu sets explicit foreground color');
  assert.match(src, /menuRow:\s*\{[^}]*color:\s*C\.text/s, 'dropdown menu rows set explicit foreground color');
});

test('vertical (tb) layout stacks layers top-to-bottom and connects bottom-to-top curves', () => {
  const nodes = [
    { id: 'lead', kind: 'lead', x: 0, y: 0 },
    { id: 'a', kind: 'agent', x: 0, y: 0 },
    { id: 'b', kind: 'agent', x: 100, y: 0 },
    { id: 'c', kind: 'condition', x: 0, y: 0 },
  ];
  const edges = [
    { from: 'lead', to: 'a', type: 'prompt' },
    { from: 'lead', to: 'b', type: 'prompt' },
    { from: 'a', to: 'c', type: 'prompt' },
    { from: 'b', to: 'c', type: 'prompt' },
  ];
  const laid = client.layoutGraph(nodes, edges, 'tb');
  const byId = new Map(laid.map((n) => [n.id, n]));
  assert.ok(byId.get('lead').y < byId.get('a').y, 'layer 1 sits below entry Lead');
  assert.equal(byId.get('a').y, byId.get('b').y, 'parallel siblings share the same vertical layer');
  assert.ok(byId.get('a').x < byId.get('b').x, 'parallel siblings spread horizontally without overlap');
  assert.ok(byId.get('c').y > byId.get('a').y + 230, 'layer 2 clears layer 1 node height');

  const curve = client.edgeCurve(byId.get('lead'), byId.get('a'), { type: 'prompt' }, 'tb');
  assert.equal(curve.c1x, curve.x1, 'vertical curve exits straight downward');
  assert.equal(curve.c2x, curve.x2, 'vertical curve enters straight from above');
  assert.ok(curve.c1y > curve.y1 && curve.c2y < curve.y2, 'vertical control points bend along Y axis');

  const inPos = client.inputSocketPos(byId.get('a'), 'tb');
  assert.equal(inPos.y, byId.get('a').y, 'tb input socket sits on top border');
  const outPos = client.outputSocketPos(byId.get('lead'), 'prompt', '', 'tb');
  assert.equal(outPos.y, byId.get('lead').y + client.nodeHeight(byId.get('lead')), 'tb output socket sits on bottom border');

  const condR = { ...byId.get('c'), tbSide: 'right' };
  const condL = { ...byId.get('c'), tbSide: 'left' };
  const condOutR = client.outputSocketPos(condR, 'prompt', 'true', 'tb');
  const condOutL = client.outputSocketPos(condL, 'prompt', 'true', 'tb');
  assert.equal(condOutR.x, condR.x + 216, 'tb condition right side exits on right border');
  assert.equal(condOutL.x, condL.x, 'tb condition left side exits on left border');
  const curveL = client.edgeCurve(condL, { id: 't', x: condL.x - 100, y: condL.y + 320 }, { type: 'prompt', branch: 'true' }, 'tb');
  assert.ok(curveL.c1x < curveL.x1 && curveL.c2y < curveL.y2, 'tb left-side condition curve exits left then bends downward');
});

test('buildPlan normalizes and serializes global and per-node refs', () => {
  const built = client.buildPlan(
    [
      { id: 'lead', kind: 'lead', task: '审查代码', refs: ['docs/spec.md', '  ', 'docs/spec.md', 'README.md'] },
      { id: 'n1', kind: 'agent', label: '审查', role: '只读检查', refs: ['src/shared.js', 'src/shared.js'] },
    ],
    [{ from: 'lead', to: 'n1', type: 'prompt' }],
  );
  assert.ok(!built.error);
  assert.deepEqual([...built.plan.refs], ['docs/spec.md', 'README.md']);
  const planN = built.plan.nodes.find((n) => n.id === 'n1');
  assert.deepEqual([...planN.refs], ['src/shared.js']);
});

test('clampMenuPos keeps context menus inside canvas bounds and flips near right/bottom edges', () => {
  assert.deepEqual({ ...client.clampMenuPos(60, 80, 400, 500, 180, 160) }, { sx: 60, sy: 80 });
  // Near right & bottom edge -> flips left and up
  const flipped = client.clampMenuPos(380, 470, 400, 500, 180, 160);
  assert.equal(flipped.sx, 200);
  assert.equal(flipped.sy, 310);
  // Tiny viewport -> clamps to safe 8px inset
  const tiny = client.clampMenuPos(20, 20, 160, 120, 180, 160);
  assert.equal(tiny.sx, 8);
  assert.equal(tiny.sy, 8);
});

test('cloneSelection duplicates selected nodes together with internal edges (including type & branch)', () => {
  const nodes = [
    { id: 'lead', kind: 'lead', task: 't', x: 0, y: 0 },
    { id: 'a', kind: 'agent', label: 'A', x: 100, y: 100, refs: ['doc.md'] },
    { id: 'c', kind: 'condition', label: 'C', x: 320, y: 100, branches: [{ id: 'true', label: '是' }, { id: 'false', label: '否' }] },
    { id: 'b', kind: 'agent', label: 'B', x: 540, y: 100 },
    { id: 'outside', kind: 'agent', label: 'Out', x: 760, y: 100 },
  ];
  const edges = [
    { id: 'e0', from: 'lead', to: 'a', type: 'prompt' },
    { id: 'e1', from: 'a', to: 'c', type: 'structured' },
    { id: 'e2', from: 'c', to: 'b', type: 'prompt', branch: 'true' },
    { id: 'e3', from: 'b', to: 'outside', type: 'session-ref' },
  ];
  const { clones, clonedEdges } = client.cloneSelection(nodes, edges, ['lead', 'a', 'c', 'b'], 't1');
  assert.equal(clones.length, 3, 'entry Lead is never cloned');
  assert.equal(clonedEdges.length, 2, 'only internal edges between cloned nodes are copied');
  const byLabel = new Map(clones.map((n) => [n.label, n]));
  const eAC = clonedEdges.find((e) => e.from === byLabel.get('A').id && e.to === byLabel.get('C').id);
  const eCB = clonedEdges.find((e) => e.from === byLabel.get('C').id && e.to === byLabel.get('B').id);
  assert.ok(eAC && eAC.type === 'structured');
  assert.ok(eCB && eCB.branch === 'true');
  // Mutating clone refs/branches does not mutate originals
  byLabel.get('A').refs.push('extra.md');
  byLabel.get('C').branches[0].label = '改名';
  assert.equal(nodes[1].refs.length, 1);
  assert.equal(nodes[2].branches[0].label, '是');
});

test('configurable shortcuts default duplicate to Shift+D, match KeyboardEvents, and clear conflicts', () => {
  assert.equal(client.DEFAULT_SHORTCUTS.duplicate, 'Shift+D');
  assert.equal(client.DEFAULT_SHORTCUTS.addNode, 'Shift+A');
  assert.equal(client.DEFAULT_SHORTCUTS.undo, 'Ctrl+Z');
  assert.equal(client.DEFAULT_SHORTCUTS.redo, 'Ctrl+Shift+Z');
  assert.equal(client.DEFAULT_SHORTCUTS.delete, 'Delete');

  assert.equal(client.normalizeShortcut('shift+d'), 'Shift+D');
  assert.equal(client.normalizeShortcut('cmd+shift+z'), 'Ctrl+Shift+Z');
  assert.equal(client.normalizeShortcut('Escape'), '');

  assert.equal(client.formatShortcutFromEvent({ key: 'Shift', shiftKey: true }), null);
  assert.equal(client.formatShortcutFromEvent({ key: 'Escape' }), null);
  assert.equal(client.formatShortcutFromEvent({ key: 'D', code: 'KeyD', shiftKey: true }), 'Shift+D');
  assert.equal(client.matchesShortcut({ key: 'D', code: 'KeyD', shiftKey: true }, 'Shift+D'), true);
  assert.equal(client.matchesShortcut({ key: 'd', code: 'KeyD', ctrlKey: true }, 'Shift+D'), false);
  assert.equal(client.matchesShortcut({ key: 'z', code: 'KeyZ', metaKey: true }, 'Ctrl+Z'), true);

  // Rebinding fitView to Shift+D automatically clears the conflict on duplicate
  const { next, clearedConflict } = client.applyShortcutBinding(client.DEFAULT_SHORTCUTS, 'fitView', 'shift+d');
  assert.equal(clearedConflict, true);
  assert.equal(next.fitView, 'Shift+D');
  assert.equal(next.duplicate, '');
});

test('nextSelectionOnNodeClick supports Shift/Ctrl additive toggle and normal single-click', () => {
  const s1 = client.nextSelectionOnNodeClick(['a'], 'b', true);
  assert.deepEqual([...s1.next], ['a', 'b']);
  assert.equal(s1.toggledOff, false);

  const s2 = client.nextSelectionOnNodeClick(['a', 'b'], 'a', true);
  assert.deepEqual([...s2.next], ['b']);
  assert.equal(s2.toggledOff, true);

  const s3 = client.nextSelectionOnNodeClick(['a', 'b'], 'a', false);
  assert.deepEqual([...s3.next], ['a', 'b'], 'plain click on already-selected node preserves group for drag');
  assert.equal(s3.toggledOff, false);

  const s4 = client.nextSelectionOnNodeClick(['a', 'b'], 'c', false);
  assert.deepEqual([...s4.next], ['c']);
  assert.equal(s4.toggledOff, false);
});

test('controlled loop helpers: membership, validation, multi-select analysis, bypass arc, buildPlan & cloneSelection', () => {
  const nodes = [
    { id: 'lead', kind: 'lead', task: 't', x: 0, y: 100 },
    { id: 'a', kind: 'agent', label: 'A', x: 300, y: 100 },
    { id: 'b', kind: 'agent', label: 'B', x: 600, y: 100 },
    { id: 'c', kind: 'condition', label: 'C', x: 900, y: 100 },
    { id: 'bypass', kind: 'agent', label: 'Bypass', x: 300, y: 400 },
  ];
  const fwdEdges = [
    { id: 'e0', from: 'lead', to: 'a', type: 'prompt' },
    { id: 'e1', from: 'a', to: 'b', type: 'prompt' },
    { id: 'e2', from: 'b', to: 'c', type: 'prompt' },
    { id: 'e3', from: 'lead', to: 'bypass', type: 'prompt' },
  ];

  // canLinkAsLoop allows condition -> strict ancestor, blocks non-condition / entry Lead / non-ancestor
  assert.equal(client.canLinkAsLoop(nodes, fwdEdges, 'c', 'a').ok, true);
  assert.equal(client.canLinkAsLoop(nodes, fwdEdges, 'b', 'a').ok, false);
  assert.equal(client.canLinkAsLoop(nodes, fwdEdges, 'c', 'lead').ok, false);
  assert.equal(client.canLinkAsLoop(nodes, fwdEdges, 'c', 'bypass').ok, false);

  // analyzeLoopSelection: single subagent auto-inserts condition; multi-select ending in condition reuses it
  const singleAgent = client.analyzeLoopSelection(nodes, fwdEdges, ['a']);
  assert.equal(singleAgent.ok, true);
  assert.equal(singleAgent.needsAutoCondition, true);
  assert.equal(client.analyzeLoopSelection(nodes, fwdEdges, ['c']).ok, false);

  const twoAgents = client.analyzeLoopSelection(nodes, fwdEdges, ['a', 'b']);
  assert.equal(twoAgents.ok, true);
  assert.equal(twoAgents.entryId, 'a');
  assert.equal(twoAgents.exitId, 'b');
  assert.equal(twoAgents.needsAutoCondition, true);

  const withCond = client.analyzeLoopSelection(nodes, fwdEdges, ['a', 'b', 'c']);
  assert.equal(withCond.ok, true);
  assert.equal(withCond.entryId, 'a');
  assert.equal(withCond.exitId, 'c');
  assert.equal(withCond.needsAutoCondition, false);

  // Disconnected selection rejected
  assert.equal(client.analyzeLoopSelection(nodes, fwdEdges, ['a', 'bypass']).ok, false);

  // With loop edge added: membership excludes bypass, crossing loop is rejected, bypass arc clears cards
  const loopEdge = { id: 'el', from: 'c', to: 'a', type: 'prompt', branch: 'false', loop: true, maxIterations: 4 };
  const allEdges = fwdEdges.concat([loopEdge]);
  assert.deepEqual(Array.from(client.loopMemberIdsUI(nodes, allEdges, loopEdge)).sort(), ['a', 'b', 'c']);
  assert.equal(client.canLinkAsLoop(nodes, allEdges, 'c', 'b').reason, 'loopOverlap');
  assert.ok(client.topoOrder(nodes, allEdges), 'topoOrder ignores controlled loop back-edges');

  const arcLR = client.loopEdgeArc(nodes[3], nodes[1], loopEdge, 'lr', nodes, allEdges);
  assert.ok(arcLR.midY < nodes[1].y + 2000, 'horizontal loop bypass rail routes above loop cards');
  assert.ok(client.distanceToEdge({ x: arcLR.midX, y: arcLR.midY }, nodes[3], nodes[1], loopEdge, 'lr', nodes, allEdges) <= 1);

  const arcTB = client.loopEdgeArc(nodes[3], nodes[1], loopEdge, 'tb', nodes, allEdges);
  assert.ok(arcTB.midX > nodes[3].x + 2000 + 216, 'vertical loop bypass rail routes outside loop cards');

  const built = client.buildPlan(nodes, allEdges);
  assert.ok(!built.error);
  const builtLoop = built.plan.edges.find((e) => e.loop);
  assert.ok(builtLoop && builtLoop.maxIterations === 4);

  // cloneSelection preserves loop metadata when duplicating the whole loop block
  const { clonedEdges } = client.cloneSelection(nodes, allEdges, ['a', 'b', 'c'], 'lp1');
  const clonedLoop = clonedEdges.find((e) => e.loop);
  assert.ok(clonedLoop && clonedLoop.maxIterations === 4 && clonedLoop.branch === 'false');

  // Breaking an internal forward edge prunes the now-invalid loop edge cleanly
  const brokenEdges = allEdges.filter((e) => e.id !== 'e1');
  const pruned = client.pruneInvalidLoopEdges(nodes, brokenEdges);
  assert.equal(pruned.removedCount, 1);
  assert.equal(pruned.edges.some((e) => e.loop), false);
  const builtBroken = client.buildPlan(nodes, brokenEdges);
  assert.ok(!builtBroken.error);
  assert.equal(builtBroken.plan.edges.some((e) => e.loop), false, 'buildPlan strips broken loop edges');

  // Built-in full-showcase retry loop starter template is valid in both zh/en and lr/tb
  for (const lang of ['zh', 'en']) {
    for (const dir of ['lr', 'tb']) {
      const loopTpl = client.builtinTemplates(lang, dir).find((t) => t.id === 'tpl-loop');
      assert.ok(loopTpl, `includes retry loop template in ${lang}/${dir}`);
      const le = loopTpl.edges.find((e) => e.loop === true);
      assert.ok(le && le.maxIterations === 3 && le.branch === 'false');
      const members = client.loopMemberIdsUI(loopTpl.nodes, loopTpl.edges, le);
      assert.equal(members.size, 2, 'loop wraps Core Implement + Quality Gate while bypassing Docs');
      assert.equal(members.has('lp_docs'), false, 'parallel bypass node stays outside loop');
      const byId = new Map(loopTpl.nodes.map((n) => [n.id, n]));
      if (dir === 'lr') {
        assert.ok(byId.get('lp_docs').y > byId.get('lp_gate').y + client.nodeHeight(byId.get('lp_gate')), 'lr: docs clears loop box vertically');
      } else {
        assert.equal(byId.get('lp_impl').x, byId.get('lp_gate').x, 'tb: loop nodes share right lane');
        assert.ok(byId.get('lp_docs').x < byId.get('lp_impl').x, 'tb: docs sits left of loop rail');
      }
    }
  }
});

test('applyPanStep + zoomAroundPoint compose cleanly without viewport snap-back (#10)', () => {
  const client = loadClientTestExports();
  let view = { k: 1, x: 100, y: 80 };
  let pan = { lastX: 300, lastY: 200 };

  // Step 1: pan +20, +10
  let s1 = client.applyPanStep(view, pan, 320, 210);
  view = s1.view;
  pan = s1.pan;
  assert.deepEqual({ ...view }, { k: 1, x: 120, y: 90 });

  // Step 2: wheel zoom around cursor (320, 210) while still panning
  const worldBeforeX = (320 - view.x) / view.k;
  const worldBeforeY = (210 - view.y) / view.k;
  view = client.zoomAroundPoint(view, 320, 210, -120, 0);
  assert.ok(view.k > 1, 'zoomed in');
  assert.ok(Math.abs((320 - view.x) / view.k - worldBeforeX) < 1e-6);
  assert.ok(Math.abs((210 - view.y) / view.k - worldBeforeY) < 1e-6);

  // Step 3: next pan mousemove (+5, -3) applies ONLY the delta on top of post-zoom view (zero jump!)
  const afterZoomX = view.x;
  const afterZoomY = view.y;
  const s3 = client.applyPanStep(view, pan, 325, 207);
  assert.ok(Math.abs(s3.view.x - (afterZoomX + 5)) < 1e-6, 'preserves zoom anchor x');
  assert.ok(Math.abs(s3.view.y - (afterZoomY - 3)) < 1e-6, 'preserves zoom anchor y');
  assert.equal(s3.view.k, view.k);
});

test('default direction persistence (#9) and preset change event dispatch (#12)', () => {
  const store = new Map();
  const events = [];
  let loaded = null;
  const sandbox = {
    window: {
      __ModuleLoader__: { load(mod) { loaded = mod; } },
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
      },
      dispatchEvent: (ev) => { events.push(ev && ev.type); },
    },
    console, Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean, RegExp, Infinity,
    encodeURIComponent, decodeURIComponent,
  };
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox);
  const c = loaded.factory((name) => (name === 'react'
    ? { createElement: () => null, useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useRef: (v) => ({ current: v }), useEffect: () => {}, Component: class {} }
    : {}
  )).__test;

  assert.equal(c.loadDefaultDirection(), 'lr');
  c.saveDefaultDirection('tb');
  assert.equal(c.loadDefaultDirection(), 'tb');
  c.saveDefaultDirection('invalid');
  assert.equal(c.loadDefaultDirection(), 'lr');

  assert.equal(c.savePresets({ demo: { nodes: [], edges: [], direction: 'tb' } }), true);
  assert.ok(events.includes('dsh-wc-presets-changed'), 'notifies other mounted tabs on preset save');
  assert.equal(c.loadPresets().demo.direction, 'tb');
});

test('stopButtonState & deriveLeadStatuses unlock waitingLead cleanly on halted (#11 & #13)', () => {
  const client = loadClientTestExports();
  const idle = client.stopButtonState({ sessionRunning: false, runningNodesCount: 0, waitingLead: null, triggering: false, stopping: false, lang: 'zh' });
  assert.equal(idle.visible, true);
  assert.equal(idle.active, false);
  assert.equal(idle.disabled, true);
  assert.equal(idle.mode, 'idle');
  assert.equal(idle.label, '⏹ 终止');

  const running = client.stopButtonState({ sessionRunning: true, runningNodesCount: 1, waitingLead: null, triggering: false, stopping: false, lang: 'zh' });
  assert.equal(running.visible, true);
  assert.equal(running.active, true);
  assert.equal(running.disabled, false);
  assert.equal(running.mode, 'running');
  assert.equal(running.label, '⏹ 终止');

  const waiting = client.stopButtonState({ sessionRunning: false, runningNodesCount: 0, waitingLead: { id: 'gate', label: 'Lead 拍板' }, triggering: false, stopping: false, lang: 'en' });
  assert.equal(waiting.visible, true);
  assert.equal(waiting.active, true);
  assert.equal(waiting.disabled, false);
  assert.equal(waiting.mode, 'waiting');
  assert.equal(waiting.label, '⏹ Stop');

  // Authoritative `halted` runState prevents stale child statusById from falsely re-locking Lead as Ready!
  const nodes = [
    { id: 'lead', kind: 'lead', label: 'Lead' },
    { id: 'a', kind: 'agent', label: '调研' },
    { id: 'gate', kind: 'lead', label: 'Lead 拍板', role: '决策' },
    { id: 'b', kind: 'agent', label: '执行' },
  ];
  const edges = [
    { id: 'e1', from: 'lead', to: 'a', type: 'prompt' },
    { id: 'e2', from: 'a', to: 'gate', type: 'prompt' },
    { id: 'e3', from: 'gate', to: 'b', type: 'prompt' },
  ];
  const paused = client.deriveLeadStatuses({
    enabled: true,
    nodes,
    edges,
    statusById: { a: 'done' },
    sessionRunning: false,
    runState: { status: 'need-lead', waitingLead: { id: 'gate', label: 'Lead 拍板' }, done: ['a'] },
  });
  assert.equal(paused.leadReadyIds.has('gate'), true);

  const halted = client.deriveLeadStatuses({
    enabled: true,
    nodes,
    edges,
    statusById: { a: 'done' },
    sessionRunning: false,
    runState: { status: 'halted', waitingLead: null, done: ['a'] },
  });
  assert.equal(halted.leadReadyIds.size, 0, 'halted runState must never re-enter awaiting Lead');
});

test('analyzeLoopSelection rejects full-graph overlap & layoutGraph(lr) spaces tall condition nodes without overlap', () => {
  const client = loadClientTestExports();
  // Full-graph overlap: A -> B -> C and A -> X -> C; X already belongs to another loop (X -> X_cond -> X)
  const nodes = [
    { id: 'lead', kind: 'lead', x: 0, y: 0 },
    { id: 'a', kind: 'agent', x: 100, y: 0 },
    { id: 'b', kind: 'agent', x: 200, y: 0 },
    { id: 'x', kind: 'agent', x: 200, y: 200 },
    { id: 'xc', kind: 'condition', x: 300, y: 200 },
    { id: 'c', kind: 'condition', x: 400, y: 0 },
  ];
  const edges = [
    { id: 'e0', from: 'lead', to: 'a' },
    { id: 'e1', from: 'a', to: 'b' },
    { id: 'e2', from: 'b', to: 'c' },
    { id: 'e3', from: 'a', to: 'x' },
    { id: 'e4', from: 'x', to: 'xc' },
    { id: 'e5', from: 'xc', to: 'c', branch: 'true' },
    { id: 'elx', from: 'xc', to: 'x', branch: 'false', loop: true, maxIterations: 2 },
  ];
  // Selecting only {a, b, c} would implicitly pull x & xc into descendants(a) ∩ ancestors(c)
  const check = client.analyzeLoopSelection(nodes, edges, ['a', 'b', 'c']);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'loopOverlap');

  // Horizontal layoutGraph('lr') must not overlap a tall 10-branch condition node with its column sibling
  const tallNodes = [
    { id: 'lead', kind: 'lead', x: 0, y: 0 },
    {
      id: 'tall', kind: 'condition', x: 100, y: 0,
      branches: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10'],
    },
    { id: 'sib', kind: 'agent', x: 100, y: 50 },
  ];
  const tallEdges = [
    { id: 't1', from: 'lead', to: 'tall' },
    { id: 't2', from: 'lead', to: 'sib' },
  ];
  const laid = client.layoutGraph(tallNodes, tallEdges, 'lr');
  const tallOut = laid.find((n) => n.id === 'tall');
  const sibOut = laid.find((n) => n.id === 'sib');
  assert.ok(sibOut.y >= tallOut.y + client.nodeHeight(tallOut) + 20, 'tall condition card must not overlap sibling below it');
});
