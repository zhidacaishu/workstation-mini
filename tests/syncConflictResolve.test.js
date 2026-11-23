const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createSync } = require('../src/sync');
const { createDiscardPreserver } = require('../src/runtime');
const { withWritesPaused } = require('../src/vault/note-queue');
const { listRecords, getRecord } = require('../src/vault/history');

const quiet = { warn() {}, log() {} };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const BASE = {
  'notes/x.md': '# X\n\n第一行\n第二行\n第三行\n',
  'notes/y.md': '# Y\n\n没人动\n',
  'notes/gone.md': '# 要删的\n\n旧内容\n',
  'reviews/2026-11-dev.jsonl': '{"event_id":"e0"}\n'
};

/** 裸远端 + 两台设备。A 当「远端那一边」，B 是跑应用的本机。 */
function twoDevices(files = BASE) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-sync-resolve-'));
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
  write(A, files);
  git(A, 'add', '-A');
  git(A, 'commit', '-m', 'init');
  git(A, 'push', '-u', 'origin', 'main');
  clone(B);
  return { root, A, B, cleanup: () => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

function write(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    if (content === null) { fs.rmSync(target, { force: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function commit(dir, files, message, { push = false } = {}) {
  write(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', message);
  if (push) git(dir, 'push');
}

const read = (dir, name) => { try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch { return null; } };

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

const REMOTE_X = '# X\n\n第一行（远端改的）\n第二行\n第三行\n';
const LOCAL_X = '# X\n\n第一行（本机改的）\n第二行\n第三行\n本机加的第四行\n';

/** 远端改 x、删 gone、记了一条复习；本机改 x、改 gone、也记了一条复习。 */
function conflicted(env) {
  commit(env.A, { 'notes/x.md': REMOTE_X, 'notes/gone.md': null, 'reviews/2026-11-dev.jsonl': '{"event_id":"e0"}\n{"event_id":"remote1"}\n' }, 'remote', { push: true });
  commit(env.B, { 'notes/x.md': LOCAL_X, 'notes/gone.md': '# 要删的\n\n本机改过\n', 'reviews/2026-11-dev.jsonl': '{"event_id":"e0"}\n{"event_id":"local1"}\n' }, 'local');
}

async function historyOf(env, notePath) {
  const records = await listRecords(path.join(env.B, 'notes'), notePath);
  return Promise.all(records.filter(record => record.kind === 'version').map(record => getRecord(path.join(env.B, 'notes'), record.id)));
}

test('冲突列表：标出两边各自有没有这个文件、差在哪里，复习日志不用选', async () => {
  const env = twoDevices();
  try {
    conflicted(env);
    const sync = syncFor(env);
    const cycle = await sync.cycle('同步');
    assert.equal(cycle.ok, false);
    assert.equal(cycle.recovery.kind, 'rebase');

    const list = await sync.listConflicts();
    assert.equal(list.resolvable, true);
    assert.deepEqual(list.files.map(file => file.path), ['notes/gone.md', 'notes/x.md', 'reviews/2026-11-dev.jsonl']);
    const [gone, x, reviews] = list.files;
    assert.deepEqual([gone.remote, gone.local, gone.current], [false, true, false], '远端删了、本机改了');
    assert.deepEqual([x.remote, x.local, x.current], [true, true, false], '文件里还有冲突标记，不能选「现在的内容」');
    assert.equal(x.diff.added, 2);
    assert.equal(x.diff.removed, 1);
    assert.equal(reviews.auto, 'union');
    // 只是看，不动现场。
    assert.match(read(env.B, 'notes/x.md'), /^<<<<<<< /m);
    assert.equal(sync.getStatus().phase, 'recovery-required');
  } finally { await env.cleanup(); }
});

test('全部用远端：正文是远端的，本机那份进历史，复习记录两边都在，之后能正常推送', async () => {
  const env = twoDevices();
  try {
    conflicted(env);
    const sync = syncFor(env);
    await sync.cycle('同步');
    const result = await sync.resolveConflicts({ 'notes/x.md': 'remote', 'notes/gone.md': 'remote' });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.resolved, 3);
    assert.equal(result.continued, 'rebase');
    assert.equal(result.recovery, undefined);
    assert.equal(read(env.B, 'notes/x.md'), REMOTE_X);
    assert.equal(read(env.B, 'notes/gone.md'), null);
    assert.deepEqual(read(env.B, 'reviews/2026-11-dev.jsonl').trim().split('\n'), ['{"event_id":"e0"}', '{"event_id":"remote1"}', '{"event_id":"local1"}']);
    assert.deepEqual(result.preserved.map(item => item.path).sort(), ['notes/gone.md', 'notes/x.md']);

    const kept = await historyOf(env, 'x.md');
    assert.equal(kept.length, 1);
    assert.equal(kept[0].reason, 'conflict');
    assert.equal(kept[0].raw, LOCAL_X);
    assert.equal((await historyOf(env, 'gone.md'))[0].raw, '# 要删的\n\n本机改过\n');

    assert.equal(git(env.B, 'status', '--porcelain'), '');
    assert.equal(sync.getStatus().phase, 'idle');
    const next = await sync.cycle('再同步');
    assert.equal(next.ok, true, next.error);
    assert.equal(git(env.B, 'rev-list', '--left-right', '--count', 'HEAD...@{u}').trim(), '0\t0');
  } finally { await env.cleanup(); }
});

test('全部用本机：正文是本机的，远端那份进历史，被远端删掉的笔记留下', async () => {
  const env = twoDevices();
  try {
    conflicted(env);
    const sync = syncFor(env);
    await sync.cycle('同步');
    const result = await sync.resolveConflicts({ 'notes/x.md': 'local', 'notes/gone.md': 'local' });

    assert.equal(result.ok, true, result.error);
    assert.equal(read(env.B, 'notes/x.md'), LOCAL_X);
    assert.equal(read(env.B, 'notes/gone.md'), '# 要删的\n\n本机改过\n');
    const kept = await historyOf(env, 'x.md');
    assert.deepEqual(kept.map(record => [record.reason, record.raw]), [['conflict', REMOTE_X]]);
    assert.equal((await historyOf(env, 'gone.md')).length, 0, '远端那边是删除，没有内容可存');
    assert.equal((await sync.cycle('再同步')).ok, true);
    // 另一台设备拉下来就是本机选的结果。
    git(env.A, 'pull', '--rebase');
    assert.equal(read(env.A, 'notes/x.md'), LOCAL_X);
  } finally { await env.cleanup(); }
});

test('只有笔记冲突、全部用远端：本机提交变空也能继续，不会卡在变基里', async () => {
  const env = twoDevices();
  try {
    commit(env.A, { 'notes/x.md': REMOTE_X }, 'remote', { push: true });
    commit(env.B, { 'notes/x.md': LOCAL_X }, 'local');
    const sync = syncFor(env);
    await sync.cycle('同步');
    const result = await sync.resolveConflicts({ 'notes/x.md': 'remote' });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.recovery, undefined);
    assert.equal(read(env.B, 'notes/x.md'), REMOTE_X);
    assert.equal(git(env.B, 'status', '--porcelain'), '');
    assert.equal(git(env.B, 'rev-list', '--left-right', '--count', 'HEAD...@{u}').trim(), '0\t0');
  } finally { await env.cleanup(); }
});

test('已经在编辑器里手工合并好的文件，可以按现在的内容保留', async () => {
  const env = twoDevices();
  try {
    commit(env.A, { 'notes/x.md': REMOTE_X }, 'remote', { push: true });
    commit(env.B, { 'notes/x.md': LOCAL_X }, 'local');
    const sync = syncFor(env);
    await sync.cycle('同步');

    const stillMarked = await sync.resolveConflicts({ 'notes/x.md': 'current' });
    assert.equal(stillMarked.ok, false);
    assert.match(stillMarked.error, /冲突标记/);
    assert.equal(stillMarked.recovery.kind, 'rebase');

    const merged = '# X\n\n第一行（两边合起来）\n第二行\n第三行\n本机加的第四行\n';
    write(env.B, { 'notes/x.md': merged });
    assert.equal((await sync.listConflicts()).files[0].current, true);
    const result = await sync.resolveConflicts({ 'notes/x.md': 'current' });
    assert.equal(result.ok, true, result.error);
    assert.equal(read(env.B, 'notes/x.md'), merged);
    const versions = await historyOf(env, 'x.md');
    assert.ok(versions.some(record => record.raw === REMOTE_X));
    assert.ok(versions.some(record => record.raw === LOCAL_X));
    assert.equal(git(env.B, 'show', 'HEAD:notes/x.md'), merged);
  } finally { await env.cleanup(); }
});

test('手工改到一半又选了远端：改到一半的内容也存进历史', async () => {
  const env = twoDevices();
  try {
    commit(env.A, { 'notes/x.md': REMOTE_X }, 'remote', { push: true });
    commit(env.B, { 'notes/x.md': LOCAL_X }, 'local');
    const sync = syncFor(env);
    await sync.cycle('同步');
    const half = '# X\n\n改到一半\n';
    write(env.B, { 'notes/x.md': half });
    const result = await sync.resolveConflicts({ 'notes/x.md': 'remote' });
    assert.equal(result.ok, true, result.error);
    assert.equal(read(env.B, 'notes/x.md'), REMOTE_X);
    assert.deepEqual((await historyOf(env, 'x.md')).map(record => record.raw).sort(), [half, LOCAL_X].sort());
  } finally { await env.cleanup(); }
});

test('手工合并结果里有 ======= 标题下划线：不当成冲突标记，可以按现在的内容保留', async () => {
  const env = twoDevices();
  try {
    commit(env.A, { 'notes/x.md': REMOTE_X }, 'remote', { push: true });
    commit(env.B, { 'notes/x.md': LOCAL_X }, 'local');
    const sync = syncFor(env);
    await sync.cycle('同步');
    const merged = 'X\n=======\n\n第一行（两边合起来）\n第二行\n第三行\n';
    write(env.B, { 'notes/x.md': merged });

    assert.equal((await sync.listConflicts()).files[0].current, true);
    const result = await sync.resolveConflicts({ 'notes/x.md': 'current' });
    assert.equal(result.ok, true, result.error);
    assert.equal(git(env.B, 'show', 'HEAD:notes/x.md'), merged);
  } finally { await env.cleanup(); }
});

test('只改好一部分冲突块又选了远端：还带标记的现有内容也存进历史', async () => {
  const env = twoDevices();
  try {
    commit(env.A, { 'notes/x.md': REMOTE_X }, 'remote', { push: true });
    commit(env.B, { 'notes/x.md': LOCAL_X }, 'local');
    const sync = syncFor(env);
    await sync.cycle('同步');
    const half = '# X\n\n手工合好的第一段\n\n<<<<<<< HEAD\n还没改的\n=======\n另一边\n>>>>>>> local\n';
    write(env.B, { 'notes/x.md': half });

    assert.equal((await sync.listConflicts()).files[0].current, false, '还有冲突块，不能按现在的内容保留');
    const result = await sync.resolveConflicts({ 'notes/x.md': 'remote' });
    assert.equal(result.ok, true, result.error);
    assert.equal(read(env.B, 'notes/x.md'), REMOTE_X);
    assert.ok((await historyOf(env, 'x.md')).some(record => record.raw === half), '改到一半的内容应存进历史');
  } finally { await env.cleanup(); }
});

test('冲突期间保存过别的笔记：不挡继续，改动一起提交', async () => {
  const env = twoDevices();
  try {
    conflicted(env);
    const sync = syncFor(env);
    await sync.cycle('同步');
    write(env.B, { 'notes/y.md': '# Y\n\n冲突期间改的\n', 'notes/new.md': '# 新笔记\n' });
    const result = await sync.resolveConflicts({ 'notes/x.md': 'remote', 'notes/gone.md': 'local' });
    assert.equal(result.ok, true, result.error);
    assert.equal(read(env.B, 'notes/y.md'), '# Y\n\n冲突期间改的\n');
    assert.equal(read(env.B, 'notes/new.md'), '# 新笔记\n');
    assert.equal(read(env.B, 'notes/gone.md'), '# 要删的\n\n本机改过\n');
    assert.equal(git(env.B, 'status', '--porcelain'), '');
  } finally { await env.cleanup(); }
});

test('没选全不动现场；选了不认识的值也不动', async () => {
  const env = twoDevices();
  try {
    conflicted(env);
    const sync = syncFor(env);
    await sync.cycle('同步');
    const before = git(env.B, 'status', '--porcelain');
    for (const choices of [{ 'notes/x.md': 'remote' }, { 'notes/x.md': 'remote', 'notes/gone.md': 'both' }, null]) {
      const result = await sync.resolveConflicts(choices);
      assert.equal(result.ok, false);
      assert.match(result.error, /还没有选/);
      assert.equal(result.resolved, 0);
      assert.equal(result.recovery.kind, 'rebase');
    }
    assert.equal(git(env.B, 'status', '--porcelain'), before);
    assert.equal((await historyOf(env, 'x.md')).length, 0);
  } finally { await env.cleanup(); }
});

test('本机有两个提交都冲突：解决第一处后停在第二处，再选一次才结束', async () => {
  const env = twoDevices();
  try {
    commit(env.A, { 'notes/x.md': REMOTE_X, 'notes/y.md': '# Y\n\n远端改的\n' }, 'remote', { push: true });
    commit(env.B, { 'notes/x.md': LOCAL_X }, 'local 1');
    commit(env.B, { 'notes/y.md': '# Y\n\n本机改的\n' }, 'local 2');
    const sync = syncFor(env);
    await sync.cycle('同步');

    const first = await sync.resolveConflicts({ 'notes/x.md': 'local' });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.more, true);
    assert.equal(first.recovery.kind, 'rebase');
    assert.deepEqual((await sync.listConflicts()).files.map(file => file.path), ['notes/y.md']);

    const second = await sync.resolveConflicts({ 'notes/y.md': 'remote' });
    assert.equal(second.ok, true, second.error);
    assert.equal(second.recovery, undefined);
    assert.equal(read(env.B, 'notes/x.md'), LOCAL_X);
    assert.equal(read(env.B, 'notes/y.md'), '# Y\n\n远端改的\n');
    assert.equal((await sync.cycle('再同步')).ok, true);
  } finally { await env.cleanup(); }
});

test('在外面手工 merge 留下的冲突：远端、本机不会认反', async () => {
  const env = twoDevices();
  try {
    commit(env.A, { 'notes/x.md': REMOTE_X }, 'remote', { push: true });
    commit(env.B, { 'notes/x.md': LOCAL_X }, 'local');
    git(env.B, 'fetch');
    try { git(env.B, 'merge', '--no-edit', 'origin/main'); } catch { /* 冲突是预期的 */ }
    const sync = syncFor(env);
    await sync.probe();
    assert.equal(sync.getStatus().recovery.kind, 'merge');
    const list = await sync.listConflicts();
    assert.equal(list.resolvable, true);
    const result = await sync.resolveConflicts({ 'notes/x.md': 'remote' });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.continued, 'merge');
    assert.equal(read(env.B, 'notes/x.md'), REMOTE_X);
    assert.deepEqual((await historyOf(env, 'x.md')).map(record => record.raw), [LOCAL_X]);
    assert.equal((await sync.cycle('再同步')).ok, true);
  } finally { await env.cleanup(); }
});

test('cherry-pick 这类分不清两边的状态不给选，现场原样留着', async () => {
  const env = twoDevices();
  try {
    commit(env.A, { 'notes/x.md': REMOTE_X }, 'remote', { push: true });
    commit(env.B, { 'notes/x.md': LOCAL_X }, 'local');
    git(env.B, 'fetch');
    try { git(env.B, 'cherry-pick', 'origin/main'); } catch { /* 冲突是预期的 */ }
    const sync = syncFor(env);
    await sync.probe();
    assert.equal(sync.getStatus().recovery.kind, 'cherry-pick');
    assert.equal((await sync.listConflicts()).resolvable, false);
    const result = await sync.resolveConflicts({ 'notes/x.md': 'remote' });
    assert.equal(result.ok, false);
    assert.match(result.error, /不能在应用里选/);
    assert.match(read(env.B, 'notes/x.md'), /^<<<<<<< /m);
    assert.equal(sync.getStatus().phase, 'recovery-required');
  } finally { await env.cleanup(); }
});

test('文件名里有通配符和空格也只动这一个文件', async () => {
  const files = { 'notes/a [1] file.md': '# 甲\n\n原文\n', 'notes/a 1.md': '# 乙\n\n别动我\n' };
  const env = twoDevices(process.platform === 'win32' ? { 'notes/a [1].md': files['notes/a [1] file.md'], 'notes/a 1.md': files['notes/a 1.md'] } : files);
  const name = process.platform === 'win32' ? 'notes/a [1].md' : 'notes/a [1] file.md';
  try {
    commit(env.A, { [name]: '# 甲\n\n远端\n' }, 'remote', { push: true });
    commit(env.B, { [name]: '# 甲\n\n本机\n' }, 'local');
    const sync = syncFor(env);
    await sync.cycle('同步');
    const result = await sync.resolveConflicts({ [name]: 'remote' });
    assert.equal(result.ok, true, result.error);
    assert.equal(read(env.B, name), '# 甲\n\n远端\n');
    assert.equal(read(env.B, 'notes/a 1.md'), '# 乙\n\n别动我\n');
  } finally { await env.cleanup(); }
});

test('没有冲突时两个接口都安静返回', async () => {
  const env = twoDevices();
  try {
    const sync = syncFor(env);
    assert.deepEqual(await sync.listConflicts(), { ok: true, recovery: null, resolvable: false, files: [] });
    const result = await sync.resolveConflicts({});
    assert.equal(result.ok, true);
    assert.match(result.skipped, /没有需要处理的冲突/);
  } finally { await env.cleanup(); }
});

test('复习日志冲突取并集后，另一边旧评分不会覆盖本机撤销', async () => {
  const { createReviewStore } = require('../src/review');
  const event = id => JSON.stringify({ event_id: id, card_id: 'card', ts: '2026-11-14T00:00:00Z', rating: 3 }) + '\n';
  const file = 'reviews/2026-11-dev.jsonl';
  const env = twoDevices({ 'notes/x.md': 'base\n', [file]: event('e1') });
  try {
    const store = createReviewStore({ vaultDir: env.B, device: 'dev' });
    await store.undo('e1');
    commit(env.A, { [file]: event('e1') + event('e2') }, 'remote append', { push: true });
    git(env.B, 'add', '-A');
    git(env.B, 'commit', '-m', 'undo');
    const sync = syncFor(env);
    assert.equal((await sync.cycle('sync')).recovery.kind, 'rebase');
    assert.equal((await sync.resolveConflicts({})).ok, true);
    assert.deepEqual((await store.readEvents()).map(event => event.eventId), ['e2']);
    assert.equal((await store.states(['card'])).get('card').reviewCount, 1);
  } finally { await env.cleanup(); }
});

test('超出上限的复习冲突日志拒绝自动合并，不清空任何一边', async () => {
  const file = 'reviews/2026-11-dev.jsonl';
  const env = twoDevices({ [file]: '{"event_id":"base"}\n' });
  try {
    const huge = '{"event_id":"large","padding":"' + 'x'.repeat(16 * 1024 * 1024) + '"}\n';
    commit(env.A, { [file]: huge + '{"event_id":"remote"}\n' }, 'remote', { push: true });
    commit(env.B, { [file]: huge + '{"event_id":"local"}\n' }, 'local');
    const sync = syncFor(env);
    assert.equal((await sync.cycle('sync')).recovery.kind, 'rebase');
    const before = fs.readFileSync(path.join(env.B, file));
    const result = await sync.resolveConflicts({});
    assert.equal(result.ok, false);
    assert.match(result.error, /上限|完整安全读取/);
    assert.equal(result.recovery.kind, 'rebase');
    assert.deepEqual(fs.readFileSync(path.join(env.B, file)), before);
    assert.ok(git(env.B, 'ls-files', '-u').trim());
  } finally { await env.cleanup(); }
});

test('复习冲突中的符号链接拒绝合并，库外文件不被修改', { skip: process.platform === 'win32' }, async () => {
  const file = 'reviews/2026-11-dev.jsonl';
  const env = twoDevices({ [file]: '{"event_id":"base"}\n' });
  try {
    const outsideA = path.join(env.root, 'outside-a.jsonl'), outsideB = path.join(env.root, 'outside-b.jsonl');
    fs.writeFileSync(outsideA, 'keep a');
    fs.writeFileSync(outsideB, 'keep b');
    for (const [dir, target] of [[env.A, outsideA], [env.B, outsideB]]) {
      fs.rmSync(path.join(dir, file));
      fs.symlinkSync(target, path.join(dir, file));
      git(dir, 'add', file); git(dir, 'commit', '-m', 'link');
    }
    git(env.A, 'push');
    const sync = syncFor(env);
    assert.equal((await sync.cycle('sync')).recovery.kind, 'rebase');
    const result = await sync.resolveConflicts({});
    assert.equal(result.ok, false);
    assert.match(result.error, /非普通文件/);
    assert.equal(fs.readFileSync(outsideA, 'utf8'), 'keep a');
    assert.equal(fs.readFileSync(outsideB, 'utf8'), 'keep b');
    assert.ok(git(env.B, 'ls-files', '-u').trim());
  } finally { await env.cleanup(); }
});

test('合并复习日志写入失败时保留完整原文件及未合并现场', async () => {
  const env = twoDevices();
  const fsp = require('node:fs/promises');
  const originalOpen = fsp.open;
  try {
    conflicted(env);
    const sync = syncFor(env);
    await sync.cycle('同步');
    const file = path.join(env.B, 'reviews/2026-11-dev.jsonl');
    fs.appendFileSync(file, '{"event_id":"uncommitted"}\n');
    const before = fs.readFileSync(file);
    fsp.open = async function(target, ...args) {
      const handle = await originalOpen.call(this, target, ...args);
      if (String(target).startsWith(file + '.tmp-')) {
        handle.writeFile = async () => { throw Object.assign(new Error('磁盘已满'), { code: 'ENOSPC' }); };
      }
      return handle;
    };
    const result = await sync.resolveConflicts({ 'notes/x.md': 'local', 'notes/gone.md': 'local' });
    assert.equal(result.ok, false);
    assert.match(result.error, /磁盘已满/);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.match(git(env.B, 'diff', '--name-only', '--diff-filter=U'), /reviews/);
    assert.equal(fs.readdirSync(path.dirname(file)).some(name => name.includes('.tmp-')), false);
  } finally {
    fsp.open = originalOpen;
    await env.cleanup();
  }
});

test('未采用的 Markdown 超出备份上限时拒绝选边并保留工作区', async () => {
  const env = twoDevices();
  try {
    commit(env.A, { 'notes/x.md': '# remote\n' + 'x'.repeat(16 * 1024 * 1024) }, 'large remote', { push: true });
    commit(env.B, { 'notes/x.md': '# local\n' }, 'local');
    const sync = syncFor(env);
    await sync.cycle('同步');
    const file = path.join(env.B, 'notes/x.md');
    fs.writeFileSync(file, '# 手工编辑中的内容\n');
    const result = await sync.resolveConflicts({ 'notes/x.md': 'local' });
    assert.equal(result.ok, false);
    assert.match(result.error, /超过自动备份大小上限/);
    assert.equal(fs.readFileSync(file, 'utf8'), '# 手工编辑中的内容\n');
    assert.match(git(env.B, 'diff', '--name-only', '--diff-filter=U'), /notes\/x.md/);
  } finally { await env.cleanup(); }
});

test('Git 路径里的字面反斜杠不映射成其他文件，不覆盖无关日志', { skip: process.platform === 'win32' }, async () => {
  const literal = 'reviews\\2026-11-dev.jsonl';
  const regular = 'reviews/2026-11-dev.jsonl';
  const env = twoDevices({ [literal]: '{"base":1}\n', [regular]: '{"unrelated":1}\n' });
  try {
    commit(env.A, { [literal]: '{"remote":1}\n' }, 'remote', { push: true });
    commit(env.B, { [literal]: '{"local":1}\n' }, 'local');
    const sync = syncFor(env);
    await sync.cycle('同步');
    const before = read(env.B, literal);
    const result = await sync.resolveConflicts({});
    assert.equal(result.ok, false);
    assert.match(result.error, /反斜杠/);
    assert.equal(read(env.B, literal), before);
    assert.equal(read(env.B, regular), '{"unrelated":1}\n');
    assert.match(git(env.B, 'diff', '--name-only', '--diff-filter=U'), /reviews/);
    const abort = await sync.abortOperation();
    assert.equal(abort.ok, false);
    assert.match(abort.error, /反斜杠/);
    assert.equal(read(env.B, literal), before);
  } finally { await env.cleanup(); }
});
