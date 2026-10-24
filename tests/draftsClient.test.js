const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function deferred() {
  let resolve; let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function setup() {
  const fields = { path: { value: 'a.md' }, body: { value: 'original' }, expectedHash: { value: 'hash1' } };
  const status = { textContent: '' };
  const listeners = {};
  const form = {
    dataset: { draftId: 'unique-editor', recovered: '0' },
    addEventListener(type, handler) { listeners[type] = handler; },
    querySelector(selector) {
      if (selector === '[data-draft-status]') return status;
      return fields[selector.match(/name="([^"]+)"/)[1]];
    }
  };
  const requests = [];
  const window = {};
  const context = {
    window, document: { querySelector: () => form },
    clearTimeout() {}, setTimeout() { return 1; },
    fetch(url, options) {
      if (!options) return Promise.resolve({ ok: true, json: async () => ({ count: 0 }) });
      const wait = deferred();
      requests.push({ url, method: options.method, body: JSON.parse(options.body), wait });
      return wait.promise;
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/public/drafts.js'), 'utf8'), context);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  return { fields, status, requests, ui: window.workstationDrafts, tick };
}
const saved = raw => new Map([['path', 'a.md'], ['body', raw]]);

test('in-flight autosave finishes before note-save cleanup, so it cannot resurrect a stale draft', async () => {
  const c = setup();
  c.fields.body.value = 'edited';
  const first = c.ui.flush(); await c.tick();
  const save = c.ui.saved(saved('edited')); await c.tick();
  assert.equal(c.requests.length, 1);
  c.requests[0].wait.resolve({ ok: true }); await first; await c.tick();
  assert.equal(c.requests[1].method, 'DELETE');
  assert.equal(c.requests[1].body.sequence, 1);
  c.requests[1].wait.resolve({ ok: true }); await save;
  assert.equal(c.status.textContent, '');
});

test('edits made while saving a note become a newer draft, never deleted as saved content', async () => {
  const c = setup();
  c.fields.body.value = 'submitted';
  const first = c.ui.flush(); await c.tick();
  c.fields.body.value = 'later unsaved edit';
  c.fields.expectedHash.value = 'hash2';
  const save = c.ui.saved(saved('submitted'));
  c.requests[0].wait.resolve({ ok: true }); await first; await c.tick();
  assert.equal(c.requests[1].method, 'POST');
  assert.equal(c.requests[1].body.raw, 'later unsaved edit');
  assert.equal(c.requests[1].body.baseHash, 'hash2');
  assert.equal(c.requests[1].body.sequence, 2);
  c.requests[1].wait.resolve({ ok: true }); await save;
  assert.match(c.status.textContent, /已保存在本机/);
});

test('failed autosave remains visible and next input can persist the latest content', async () => {
  const c = setup();
  c.fields.body.value = 'first';
  const first = c.ui.flush(); await c.tick();
  c.requests[0].wait.reject(new Error('network')); await first;
  assert.match(c.status.textContent, /未确认保存/);
  c.fields.body.value = 'latest';
  const second = c.ui.flush(); await c.tick();
  assert.equal(c.requests[1].body.raw, 'latest');
  c.requests[1].wait.resolve({ ok: true }); await second;
  assert.match(c.status.textContent, /已保存在本机/);
});
