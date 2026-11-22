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

test('soloLeadNodeIds marks solo chained Leads inactive/skipped while allowing Lead + Subagent -> Lead', () => {
  const nodes = [
    { id: 'lead', kind: 'lead', task: 't' },
    { id: 'a1', kind: 'agent', label: 'Agent 1' },
    { id: 'a2', kind: 'agent', label: 'Agent 2' },
    { id: 'l1', kind: 'lead', label: 'Lead 1' },
    { id: 'l2', kind: 'lead', label: 'Lead 2' },
  ];
  // Solo chain l1 -> l2 (no subagent into l2): l2 is inactive/skipped
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

  // Mixed chain l1 -> l2 AND a2 -> l2: l2 has a subagent upstream so it is active
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
  const curve = client.edgeCurve(byId.get(blue.from), byId.get(blue.to), blue.type);
  assert.equal(curve.y1, curve.y2, 'horizontal structured edge exists and must remain visible');
});
