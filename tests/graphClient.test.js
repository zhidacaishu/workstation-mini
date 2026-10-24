const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

class FakeElement {
  constructor(name) {
    this.name = name;
    this.attributes = {};
    this.children = [];
    this.dataset = {};
    this.clientWidth = name === 'box' ? 800 : 0;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...children) { this.children.push(...children); }
}

async function graphSource() {
  return fs.readFile(path.join(__dirname, '..', 'src', 'public', 'graph.js'), 'utf8');
}

function loadGraph(Worker) {
  const box = new FakeElement('box');
  box.dataset.graph = encodeURIComponent(JSON.stringify({
    nodes: [{ id: 'a', label: '甲', path: 'dir/a.md', degree: 1 }, { id: 'b', label: '乙', degree: 1 }],
    edges: [{ from: 'a', to: 'b' }]
  }));
  const document = {
    getElementById(id) { return id === 'graph' ? box : null; },
    createElementNS(_ns, name) { return new FakeElement(name); }
  };
  vm.runInNewContext(loadGraph.source, { document, Worker, Math, Map, Number, JSON, decodeURIComponent, encodeURIComponent });
  return box;
}

test.before(async () => { loadGraph.source = await graphSource(); });

test('先画圆形布局，再把 300 步计算交给 Worker', () => {
  let instance;
  class Worker {
    constructor(url) { this.url = url; this.listeners = new Map(); instance = this; }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    postMessage(payload) { this.payload = payload; }
    terminate() { this.terminated = true; }
  }
  const box = loadGraph(Worker);
  const svg = box.children[0];
  const link = svg.children.find(child => child.name === 'a');
  assert.equal(instance.url, '/static/graph-worker.js');
  assert.equal(instance.payload.steps, 300);
  assert.equal(link.attributes.href, '/note/dir/a.md');
  assert.equal(link.attributes['aria-label'], '甲');
  assert.ok(svg.children.some(child => child.name === 'circle' || child.children.some(item => item.name === 'circle')));
});

test('Worker 结果必须完整、唯一且有限，否则原子保留圆形布局', () => {
  let instance;
  class Worker {
    constructor() { this.listeners = new Map(); instance = this; }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    postMessage() {}
    terminate() { this.terminated = true; }
  }
  const invalidResults = [
    [{ id: 'a', x: 10, y: 20 }],
    [{ id: 'a', x: 10, y: 20 }, { id: 'a', x: 30, y: 40 }],
    [{ id: 'a', x: 10, y: 20 }, { id: 'unknown', x: 30, y: 40 }],
    [{ id: 'a', x: 10, y: 20 }, { id: 'b', x: Number.NaN, y: 40 }]
  ];

  for (const result of invalidResults) {
    const box = loadGraph(Worker);
    const circles = box.children[0].children.flatMap(child => child.children || []).filter(child => child.name === 'circle');
    const before = circles.map(circle => [circle.attributes.cx, circle.attributes.cy]);
    instance.listeners.get('message')({ data: { nodes: result } });
    assert.deepEqual(circles.map(circle => [circle.attributes.cx, circle.attributes.cy]), before);
    assert.equal(instance.terminated, true);
  }
});

test('Worker 构造失败时保留圆形图，不在主线程回退计算', () => {
  class Worker { constructor() { throw new Error('blocked'); } }
  const box = loadGraph(Worker);
  assert.equal(box.children[0].name, 'svg');
  const circles = box.children[0].children.flatMap(child => child.children || []).filter(child => child.name === 'circle');
  assert.equal(circles.length, 2);
  assert.ok(circles.every(circle => Number.isFinite(Number(circle.attributes.cx))));
});
