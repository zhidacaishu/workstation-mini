const test = require('node:test');
const assert = require('node:assert/strict');

const { createQuitCoordinator } = require('../electron/quit-coordinator');

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

function stubWindow({ veto = false, minimized = false, decision } = {}) {
  const calls = [];
  return {
    calls,
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    isMinimized() { return minimized; },
    restore() { calls.push('restore'); minimized = false; },
    show() { calls.push('show'); },
    focus() { calls.push('focus'); },
    webContents: {
      async executeJavaScript(source) {
        calls.push('beforeunload');
        assert.match(source, /beforeunload/);
        if (decision) return decision.promise;
        return veto;
      }
    }
  };
}

test('renderer 裁决完成前不执行退出副作用', async () => {
  const decision = deferred();
  const window = stubWindow({ decision });
  const calls = [];
  const coordinator = createQuitCoordinator({
    getWindows: () => [window],
    onAccepted: async () => { calls.push('accepted'); return { ok: true }; }
  });

  const result = coordinator.request();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []);
  assert.equal(coordinator.isAccepted(), false);

  decision.resolve(false);
  assert.deepEqual(await result, { ok: true });
  assert.deepEqual(calls, ['accepted']);
  assert.equal(coordinator.isAccepted(), true);
});

test('任一窗口 veto 时停止裁决，显示并聚焦 veto 窗口，允许重试', async () => {
  const first = stubWindow();
  const veto = stubWindow({ veto: true, minimized: true });
  const later = stubWindow();
  let accepted = 0;
  const coordinator = createQuitCoordinator({
    getWindows: () => [first, veto, later],
    onAccepted: async () => { accepted += 1; return { ok: true }; }
  });

  assert.deepEqual(await coordinator.request(), { cancelled: true });
  assert.deepEqual(first.calls, ['beforeunload']);
  assert.deepEqual(veto.calls, ['beforeunload', 'restore', 'show', 'focus']);
  assert.deepEqual(later.calls, []);
  assert.equal(accepted, 0);
  assert.equal(coordinator.isAccepted(), false);

  veto.webContents.executeJavaScript = async () => {
    veto.calls.push('beforeunload');
    return false;
  };
  assert.deepEqual(await coordinator.request(), { ok: true });
  assert.equal(accepted, 1);
});

test('并发退出请求共用一次两阶段退出', async () => {
  const window = stubWindow();
  let accepted = 0;
  const coordinator = createQuitCoordinator({
    getWindows: () => [window],
    onAccepted: async () => { accepted += 1; return { ok: true }; }
  });

  const first = coordinator.request();
  const second = coordinator.request();
  assert.equal(first, second);
  assert.deepEqual(await first, { ok: true });
  assert.equal(accepted, 1);
  assert.deepEqual(window.calls, ['beforeunload']);
});

test('忽略已销毁窗口', async () => {
  const destroyed = stubWindow({ veto: true });
  destroyed.destroyed = true;
  const coordinator = createQuitCoordinator({
    getWindows: () => [destroyed],
    onAccepted: async () => ({ ok: true })
  });

  assert.deepEqual(await coordinator.request(), { ok: true });
  assert.deepEqual(destroyed.calls, []);
});

test('renderer 裁决返回时窗口已销毁则忽略 veto', async () => {
  const decision = deferred();
  const window = stubWindow({ decision });
  const coordinator = createQuitCoordinator({
    getWindows: () => [window],
    onAccepted: async () => ({ ok: true })
  });

  const request = coordinator.request();
  await new Promise(resolve => setImmediate(resolve));
  window.destroyed = true;
  decision.resolve(true);

  assert.deepEqual(await request, { ok: true });
  assert.deepEqual(window.calls, ['beforeunload']);
});
