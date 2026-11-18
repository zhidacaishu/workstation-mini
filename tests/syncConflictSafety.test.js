const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createSync } = require('../src/sync');
const { createDiscardPreserver } = require('../src/runtime');
const { createReviewStore } = require('../src/review');
const { withWritesPaused, enqueueNote } = require('../src/vault/note-queue');
const { writeNote } = require('../src/vault/note');
const { listRecords, getRecord } = require('../src/vault/history');

const quiet = { warn() {}, log() {} };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** 一个裸远端和两台设备的克隆；A 已经推过一个初始提交。 */
function twoDevices(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-sync-safety-'));
  const remote = path.join(root, 'remote.git');
  const A = path.join(root, 'A');
  const B = path.join(root, 'B');
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { stdio: 'ignore' });
  const clone = target => {
    // 克隆检出前就固定 LF，避免 Windows 全局 autocrlf 污染初始文件。
    execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'clone', remote, target], { stdio: 'ignore' });
    git(target, 'config', 'user.name', 'tester');
    git(target, 'config', 'user.email', 'tester@example.invalid');
    git(target, 'config', 'core.autocrlf', 'false');
    git(target, 'config', 'core.eol', 'lf');
  };
  clone(A);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(A, name)), { recursive: true });
    fs.writeFileSync(path.join(A, name), content);
  }
  git(A, 'add', '-A');
  git(A, 'commit', '-m', 'init');
  git(A, 'push', '-u', 'origin', 'main');
  clone(B);
  return { root, remote, A, B, cleanup: () => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

function pushFromA(env, name, content) {
  fs.writeFileSync(path.join(env.A, name), content);
  git(env.A, 'commit', '-am', 'A edit');
  git(env.A, 'push');
}

function syncFor(env, options = {}) {
  return createSync({
    vaultDir: env.B,
    enabled: true,
    reviewSyncEnabled: true,
    pauseWrites: withWritesPaused,
    preserveDiscarded: createDiscardPreserver({ vaultDir: env.B, notesDir: path.join(env.B, 'notes') }),
    logger: quiet,
    ...options
  });
}

test('复习同步遇到未提交的笔记修改时不变基，不把冲突标记写进正文', async () => {
  const env = twoDevices({ 'notes/inbox/n.md': '# 标题\n\n第一行\n', 'reviews/2026-11-a.jsonl': '' });
  try {
    pushFromA(env, 'notes/inbox/n.md', '# 标题\n\n设备 A 的修改\n');
    const local = '# 标题\n\n设备 B 的修改（尚未提交）\n';
    fs.writeFileSync(path.join(env.B, 'notes/inbox/n.md'), local);
    fs.writeFileSync(path.join(env.B, 'reviews/2026-11-b.jsonl'), '{"card_id":"x","ts":"2026-11-12T00:00:00.000Z","rating":3}\n');

    const sync = syncFor(env);
    const result = await sync.syncReviewLogs('b', '复习记录');

    assert.equal(result.ok, true);
    assert.equal(result.committed, true, '复习日志仍然在本机提交');
    assert.equal(result.pushed, false);
    assert.equal(result.deferred, 'local-changes');
    assert.equal(fs.readFileSync(path.join(env.B, 'notes/inbox/n.md'), 'utf8'), local, '笔记原样不动');
    assert.equal(sync.getStatus().recovery, null, '没有留下需要恢复的现场');
    assert.equal(git(env.B, 'stash', 'list').trim(), '', '没有用过 stash');
    assert.equal(git(env.B, 'status', '--porcelain').trim(), 'M notes/inbox/n.md');
  } finally { await env.cleanup(); }
});

test('复习同步在工作区干净时照常变基并推送', async () => {
  const env = twoDevices({ 'notes/inbox/n.md': '# 标题\n', 'reviews/2026-11-a.jsonl': '' });
  try {
    pushFromA(env, 'notes/inbox/n.md', '# 标题\n\n别的设备的新内容\n');
    fs.writeFileSync(path.join(env.B, 'reviews/2026-11-b.jsonl'), '{"card_id":"x","ts":"2026-11-12T00:00:00.000Z","rating":3}\n');

    const result = await syncFor(env).syncReviewLogs('b', '复习记录');

    assert.equal(result.ok, true);
    assert.equal(result.committed, true);
    assert.equal(result.pushed, true);
    assert.equal(result.changed, true, '拉到了别的设备的修改，调用方要重扫索引');
    assert.match(fs.readFileSync(path.join(env.B, 'notes/inbox/n.md'), 'utf8'), /别的设备的新内容/);
    assert.equal(git(env.B, 'rev-list', '--count', 'origin/main..HEAD').trim(), '0');
  } finally { await env.cleanup(); }
});

test('远端没有新提交时，即使有未提交的笔记修改也直接推送复习记录', async () => {
  const env = twoDevices({ 'notes/inbox/n.md': '# 标题\n', 'reviews/2026-11-a.jsonl': '' });
  try {
    fs.writeFileSync(path.join(env.B, 'notes/inbox/n.md'), '# 标题\n\n本机未提交\n');
    fs.writeFileSync(path.join(env.B, 'reviews/2026-11-b.jsonl'), '{"card_id":"x","ts":"2026-11-12T00:00:00.000Z","rating":3}\n');

    const result = await syncFor(env).syncReviewLogs('b', '复习记录');

    assert.equal(result.ok, true);
    assert.equal(result.pushed, true);
    assert.equal(result.deferred, undefined);
    assert.equal(git(env.B, 'status', '--porcelain').trim(), 'M notes/inbox/n.md');
  } finally { await env.cleanup(); }
});

test('中止变基前，把冲突期间保存的笔记存进本机历史', async () => {
  const env = twoDevices({ 'notes/inbox/n.md': '# 标题\n\n第一行\n', 'notes/inbox/other.md': '# 另一篇\n\n原文\n' });
  try {
    pushFromA(env, 'notes/inbox/n.md', '# 标题\n\n设备 A 的修改\n');
    fs.writeFileSync(path.join(env.B, 'notes/inbox/n.md'), '# 标题\n\n设备 B 的修改\n');
    const sync = syncFor(env);
    const cycle = await sync.cycle('周期同步');
    assert.equal(cycle.recovery?.kind, 'rebase');
    assert.equal(cycle.recovery.abortable, true);

    const notes = path.join(env.B, 'notes');
    const merged = '# 标题\n\n我手动合并好的最终版本\n';
    const extra = '# 另一篇\n\n原文\n\n冲突期间新写的内容\n';
    await enqueueNote(notes, 'inbox/n.md', () => writeNote(notes, 'inbox/n.md', { raw: merged }));
    await enqueueNote(notes, 'inbox/other.md', () => writeNote(notes, 'inbox/other.md', { raw: extra }));

    const aborted = await sync.abortOperation();
    assert.equal(aborted.ok, true);
    assert.equal(aborted.aborted, 'rebase');
    assert.deepEqual(aborted.preserved.map(item => `${item.kind}:${item.path}`).sort(),
      ['history:notes/inbox/n.md', 'history:notes/inbox/other.md']);

    // 正文回到中止前的本机版本；撤掉的内容在历史里。
    assert.equal(fs.readFileSync(path.join(notes, 'inbox/n.md'), 'utf8'), '# 标题\n\n设备 B 的修改\n');
    assert.equal(fs.readFileSync(path.join(notes, 'inbox/other.md'), 'utf8'), '# 另一篇\n\n原文\n');
    for (const [notePath, expected] of [['inbox/n.md', merged], ['inbox/other.md', extra]]) {
      const records = await listRecords(notes, notePath);
      const abortRecord = records.find(record => record.reason === 'abort');
      assert.ok(abortRecord, `${notePath} 应有一条中止前的历史`);
      assert.equal((await getRecord(notes, abortRecord.id)).raw, expected);
    }
  } finally { await env.cleanup(); }
});

test('中止变基后，冲突期间的复习记录自动补回', async () => {
  const env = twoDevices({ 'notes/inbox/n.md': '# 标题\n\n第一行\n' });
  try {
    const store = createReviewStore({ vaultDir: env.B, device: 'b' });
    await store.record('deck/card1', 3, 1000, 'e1');
    pushFromA(env, 'notes/inbox/n.md', '# 标题\n\nA\n');
    fs.writeFileSync(path.join(env.B, 'notes/inbox/n.md'), '# 标题\n\nB\n');
    const sync = syncFor(env);
    assert.equal((await sync.cycle('周期同步')).recovery?.kind, 'rebase');

    await store.record('deck/card2', 3, 1000, 'e2');
    await store.record('deck/card3', 1, 1000, 'e3');

    const aborted = await sync.abortOperation();
    assert.equal(aborted.ok, true);
    assert.deepEqual(aborted.preserved.filter(item => item.kind === 'review').map(item => item.count), [2]);
    assert.deepEqual((await store.readEvents()).map(event => event.eventId).sort(), ['e1', 'e2', 'e3']);
  } finally { await env.cleanup(); }
});

test('复习评分经过写入闸门：暂停写入期间不落盘，放开后才写', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-review-gate-'));
  try {
    const store = createReviewStore({ vaultDir, device: 'b' });
    await store.record('deck/warmup', 3, 1000, 'e0');
    const logs = () => fs.readdirSync(path.join(vaultDir, 'reviews'))
      .flatMap(name => fs.readFileSync(path.join(vaultDir, 'reviews', name), 'utf8').split('\n').filter(Boolean));

    let recorded;
    await withWritesPaused(async () => {
      recorded = store.record('deck/card', 3, 1000, 'e1');
      await new Promise(resolve => setTimeout(resolve, 80));
      assert.equal(logs().length, 1, '闸门落下期间评分不该写进日志');
    });
    await recorded;
    assert.equal(logs().length, 2);
  } finally { fs.rmSync(vaultDir, { recursive: true, force: true }); }
});

// 这两条用 pre-push 钩子里的 sleep 拖慢推送，只在类 Unix 上跑。
const HOOK_SLEEP = { skip: process.platform === 'win32' };

test('联网命令不受本地命令的超时限制，慢推送能推完', HOOK_SLEEP, async () => {
  const env = twoDevices({ 'notes/a.md': '# a\n' });
  try {
    // 钩子让每次推送至少花 1.2 秒；本地命令的超时只有 600 毫秒。
    fs.writeFileSync(path.join(env.B, '.git/hooks/pre-push'), '#!/bin/sh\nsleep 1.2\n', { mode: 0o755 });
    fs.appendFileSync(path.join(env.B, 'notes/a.md'), '新的一行\n');
    const sync = createSync({ vaultDir: env.B, enabled: true, timeoutMs: 600, logger: quiet });

    const result = await sync.cycle('同步');

    assert.equal(result.ok, true, result.error);
    assert.equal(git(env.B, 'rev-list', '--count', 'origin/main..HEAD').trim(), '0');
  } finally { await env.cleanup(); }
});

test('联网命令真的超时时，错误信息写明是超时', HOOK_SLEEP, async () => {
  const env = twoDevices({ 'notes/a.md': '# a\n' });
  try {
    fs.writeFileSync(path.join(env.B, '.git/hooks/pre-push'), '#!/bin/sh\nsleep 3\n', { mode: 0o755 });
    fs.appendFileSync(path.join(env.B, 'notes/a.md'), '新的一行\n');
    const sync = createSync({ vaultDir: env.B, enabled: true, networkTimeoutMs: 500, logger: quiet });

    const result = await sync.cycle('同步');

    assert.equal(result.ok, false);
    assert.match(result.error, /Git push 超过 \d+ 秒没有完成/);
    assert.doesNotMatch(result.error, /Command failed/);
  } finally { await env.cleanup(); }
});

test('中止保全暂存和工作区两个版本，复习只补回工作区的最终事件', async () => {
  const log = 'reviews/2026-11-b.jsonl';
  const env = twoDevices({ 'notes/x.md': 'base\n', 'notes/y.md': 'original\n', [log]: '' });
  try {
    pushFromA(env, 'notes/x.md', 'remote\n');
    fs.writeFileSync(path.join(env.B, 'notes/x.md'), 'local\n');
    const sync = syncFor(env);
    assert.equal((await sync.cycle('local')).recovery.kind, 'rebase');
    fs.writeFileSync(path.join(env.B, 'notes/y.md'), 'staged edit\n');
    fs.writeFileSync(path.join(env.B, 'notes/new.md'), 'staged new\n');
    const stagedEvent = '{"event_id":"e1","rating":1}\n';
    const finalEvent = '{"event_id":"e1","rating":3}\n';
    fs.writeFileSync(path.join(env.B, log), stagedEvent);
    git(env.B, 'add', 'notes/y.md', 'notes/new.md', log);
    fs.writeFileSync(path.join(env.B, log), finalEvent);
    fs.writeFileSync(path.join(env.B, 'notes/y.md'), 'worktree edit\n');
    const result = await sync.abortOperation();
    assert.equal(result.ok, true, result.error);
    const notes = path.join(env.B, 'notes');
    for (const [file, expected] of [['y.md', ['staged edit\n', 'worktree edit\n']], ['new.md', ['staged new\n']]]) {
      const records = (await listRecords(notes, file)).filter(r => r.reason === 'abort');
      const versions = await Promise.all(records.map(r => getRecord(notes, r.id)));
      assert.deepEqual(versions.map(r => r.raw).sort(), expected);
    }
    const backups = fs.readdirSync(path.join(env.B, '.workstation-local/git-abort'));
    const snapshot = JSON.parse(fs.readFileSync(path.join(env.B, '.workstation-local/git-abort', backups[0])));
    assert.equal(fs.readFileSync(path.join(env.B, log), 'utf8'), finalEvent);
    assert.ok(snapshot.files.some(file => file.path === log && file.content === stagedEvent));
    assert.deepEqual(snapshot.files.filter(file => file.path === 'notes/y.md').map(file => file.content).sort(),
      ['staged edit\n', 'worktree edit\n']);
    assert.ok(snapshot.files.some(file => file.path === 'notes/new.md' && file.content === 'staged new\n'));
  } finally { await env.cleanup(); }
});

test('中止前备份失败时保留 Git 冲突和未提交内容，报告失败', async () => {
  const env = twoDevices({ 'notes/x.md': 'base\n', 'notes/y.md': 'original\n' });
  try {
    pushFromA(env, 'notes/x.md', 'remote\n');
    fs.writeFileSync(path.join(env.B, 'notes/x.md'), 'local\n');
    const sync = syncFor(env, { preserveDiscarded: async () => { throw new Error('disk full'); } });
    await sync.cycle('local');
    fs.writeFileSync(path.join(env.B, 'notes/y.md'), 'precious edit\n');
    const result = await sync.abortOperation();
    assert.equal(result.ok, false);
    assert.match(result.error, /disk full/);
    assert.equal(result.recovery.kind, 'rebase');
    assert.equal(fs.readFileSync(path.join(env.B, 'notes/y.md'), 'utf8'), 'precious edit\n');
    assert.match(fs.readFileSync(path.join(env.B, 'notes/x.md'), 'utf8'), /<<<<<<< /);
  } finally { await env.cleanup(); }
});

test('冲突期间撤销评分，中止变基后撤销仍然有效', async () => {
  const env = twoDevices({ 'notes/x.md': 'base\n' });
  try {
    const store = createReviewStore({ vaultDir: env.B, device: 'b' });
    await store.record('card', 3, 10, 'e1');
    pushFromA(env, 'notes/x.md', 'remote\n');
    fs.writeFileSync(path.join(env.B, 'notes/x.md'), 'local\n');
    const sync = syncFor(env);
    await sync.cycle('local');
    await store.undo('e1');
    assert.equal((await store.readEvents()).length, 0);
    assert.equal((await sync.abortOperation()).ok, true);
    assert.equal((await store.readEvents()).length, 0);
    assert.equal((await store.states(['card'])).size, 0);
  } finally { await env.cleanup(); }
});

test('持久快照目录不可写时，在 Git 中止之前失败，不撤掉用户修改', async () => {
  const env = twoDevices({ 'notes/x.md': 'base\n' });
  try {
    pushFromA(env, 'notes/x.md', 'remote\n');
    fs.writeFileSync(path.join(env.B, 'notes/x.md'), 'local\n');
    const sync = syncFor(env);
    await sync.cycle('local');
    const conflict = fs.readFileSync(path.join(env.B, 'notes/x.md'), 'utf8');
    fs.mkdirSync(path.join(env.B, '.workstation-local'), { recursive: true });
    fs.writeFileSync(path.join(env.B, '.workstation-local/git-abort'), 'blocked');
    const result = await sync.abortOperation();
    assert.equal(result.ok, false);
    assert.equal(result.recovery.kind, 'rebase');
    assert.equal(fs.readFileSync(path.join(env.B, 'notes/x.md'), 'utf8'), conflict);
  } finally { await env.cleanup(); }
});

test('中止后恢复日志拒绝 Git 还原的符号链接，类型变更也先保全', { skip: process.platform === 'win32' }, async t => {
  for (const staged of [false, true]) {
    await t.test(staged ? '已暂存类型变更' : '未暂存类型变更', async () => {
      const env = twoDevices({ 'notes/x.md': 'base\n', 'reviews/2026-11-dev.jsonl': '' });
      try {
        const outside = path.join(env.root, 'outside.txt');
        fs.writeFileSync(outside, '库外内容\n');
        fs.rmSync(path.join(env.A, 'reviews/2026-11-dev.jsonl'));
        fs.symlinkSync(outside, path.join(env.A, 'reviews/2026-11-dev.jsonl'));
        git(env.A, 'add', '-A');
        git(env.A, 'commit', '-m', 'symlink fixture');
        git(env.A, 'push');
        git(env.B, 'pull', '--ff-only');
        pushFromA(env, 'notes/x.md', 'remote\n');
        fs.writeFileSync(path.join(env.B, 'notes/x.md'), 'local\n');
        const sync = syncFor(env);
        assert.equal((await sync.cycle('local')).recovery.kind, 'rebase');
        const reviewPath = path.join(env.B, 'reviews/2026-11-dev.jsonl');
        fs.rmSync(reviewPath);
        fs.writeFileSync(reviewPath, '{"event_id":"precious"}\n');
        if (staged) git(env.B, 'add', 'reviews/2026-11-dev.jsonl');
        const result = await sync.abortOperation();
        assert.equal(result.ok, false);
        assert.equal(result.aborted, 'rebase');
        assert.match(result.error, /恢复.*失败/);
        assert.equal(fs.readFileSync(outside, 'utf8'), '库外内容\n');
        const backup = JSON.parse(fs.readFileSync(path.join(env.B, result.backupPath), 'utf8'));
        assert.ok(backup.files.some(file => file.path === 'reviews/2026-11-dev.jsonl' && file.content.includes('precious')));
      } finally { await env.cleanup(); }
    });
  }
});
