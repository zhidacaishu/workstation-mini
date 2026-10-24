const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { enqueueNote } = require('../src/vault/note-queue');

test('同一路径串行、不同路径并行，失败不会毒化后续任务', async () => {
  const notesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-note-queue-'));
  try {
    const events = [];
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });

    const first = enqueueNote(notesDir, 'a.md', async () => {
      events.push('a1-start');
      await firstGate;
      events.push('a1-end');
    });
    const second = enqueueNote(notesDir, 'a.md', async () => events.push('a2'));
    const other = enqueueNote(notesDir, 'b.md', async () => events.push('b'));

    await other;
    assert.deepEqual(events, ['a1-start', 'b']);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['a1-start', 'b', 'a1-end', 'a2']);

    await assert.rejects(enqueueNote(notesDir, 'a.md', async () => { throw new Error('boom'); }), /boom/);
    await enqueueNote(notesDir, 'a.md', async () => events.push('after-error'));
    assert.equal(events.at(-1), 'after-error');
  } finally {
    await fs.rm(notesDir, { recursive: true, force: true });
  }
});

async function pathsAlias(root, original, alias) {
  const originalPath = path.join(root, original);
  const aliasPath = path.join(root, alias);
  await fs.writeFile(originalPath, 'probe', { flag: 'wx' });
  try {
    const [left, right] = await Promise.all([
      fs.stat(originalPath),
      fs.stat(aliasPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
    ]);
    return Boolean(right && left.dev === right.dev && left.ino === right.ino);
  } finally {
    await fs.rm(originalPath, { force: true });
  }
}

async function assertAliasQueue(notesDir, firstPath, secondPath, shouldSerialize) {
  const events = [];
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const firstStarted = new Promise(resolve => { started = resolve; });
  const first = enqueueNote(notesDir, firstPath, async () => {
    events.push('first');
    started();
    await gate;
    events.push('released');
  });
  await firstStarted;
  const second = enqueueNote(notesDir, secondPath, async () => events.push('second'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.includes('second'), !shouldSerialize);
  release();
  await Promise.all([first, second]);
  if (shouldSerialize) assert.deepEqual(events, ['first', 'released', 'second']);
}

test('队列按实际文件系统语义串行大小写和 Unicode 别名', async () => {
  const notesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-note-queue-alias-'));
  try {
    const caseAlias = await pathsAlias(notesDir, 'CaseProbe.md', 'caseprobe.md');
    const unicodeAlias = await pathsAlias(notesDir, 'café.md', 'café.md');
    await assertAliasQueue(notesDir, 'A.md', 'a.md', caseAlias);
    await assertAliasQueue(notesDir, 'é.md', 'é.md', unicodeAlias);

    const leftovers = (await fs.readdir(notesDir)).filter(name => name.startsWith('.workstation-fs-'));
    assert.deepEqual(leftovers, []);
  } finally {
    await fs.rm(notesDir, { recursive: true, force: true });
  }
});

test('同路径重入直接执行，不会等自己（否则那把锁再也解不开）', async () => {
  const notesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-note-queue-reentrant-'));
  const deadline = promise => Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('死锁：重入等到了自己')), 2000))
  ]);

  try {
    // 一个写入过程里顺带落一篇派生笔记（processAnnotation → ensurePermanentNote
    // 就是这个形状）。目标恰好是同一路径时，内层排的是自己后面，永远等不到，
    // 而且那个 key 会一直留在队列表里，之后所有对这篇笔记的写入全部挂住。
    const nested = await deadline(enqueueNote(notesDir, 'a.md', async () => {
      const inner = await enqueueNote(notesDir, 'a.md', async () => 'inner');
      return `outer+${inner}`;
    }));
    assert.equal(nested, 'outer+inner');

    // 隔一层别的路径再绕回来，同样不能自锁。
    const deep = await deadline(enqueueNote(notesDir, 'a.md', async () => (
      enqueueNote(notesDir, 'b.md', async () => enqueueNote(notesDir, 'a.md', async () => 'deep'))
    )));
    assert.equal(deep, 'deep');

    // 重入之后这个 key 仍然可用，没被毒死。
    assert.equal(await deadline(enqueueNote(notesDir, 'a.md', async () => 'still-works')), 'still-works');

    // 串行性不能因为可重入就丢了：外层没跑完，别的调用方仍要排队。
    const events = [];
    const slow = ms => new Promise(resolve => setTimeout(resolve, ms));
    await Promise.all([
      enqueueNote(notesDir, 'c.md', async () => {
        events.push('A-start');
        await enqueueNote(notesDir, 'c.md', async () => { await slow(40); events.push('A-inner'); });
        events.push('A-end');
      }),
      enqueueNote(notesDir, 'c.md', async () => { events.push('B'); })
    ]);
    assert.deepEqual(events, ['A-start', 'A-inner', 'A-end', 'B']);
  } finally {
    await fs.rm(notesDir, { recursive: true, force: true });
  }
});
