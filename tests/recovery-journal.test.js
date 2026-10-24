const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createRecoveryJournal,
  createOwnedStaging,
  OWNER_FILE
} = require('../src/recovery/journal');

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-recovery-journal-'));
  const journal = createRecoveryJournal({
    journalPath: path.join(root, 'user-data', 'recovery-session.json'),
    now: () => '2026-08-23T00:00:00.000Z'
  });
  return { root, journal, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('journal 只保存安全字段并可重复原子覆盖', async () => {
  const ctx = await setup();
  try {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const destinationPath = path.join(ctx.root, 'restored');
    const owned = await createOwnedStaging({ destinationParent: ctx.root, destinationPath, sessionId });
    const remote = 'https://user:secret@example.com/private.git';
    await ctx.journal.write({
      sessionId, mode: 'restore', ...owned, destinationPath,
      phase: 'prepared', remote, token: 'super-secret', createdAt: '2026-08-23T00:00:00.000Z'
    });
    await ctx.journal.write({
      sessionId, mode: 'restore', ...owned, destinationPath,
      phase: 'candidate-present', createdAt: '2026-08-23T00:00:00.000Z',
      lastError: { stage: 'git', code: 'authentication-failed', stderr: remote }
    });

    const raw = await fs.readFile(ctx.journal.journalPath, 'utf8');
    assert.ok(!raw.includes('secret'));
    assert.ok(!raw.includes('private.git'));
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), [
      'createdAt', 'destinationPath', 'lastError', 'mode', 'phase',
      'sessionId', 'stagingRoot', 'updatedAt', 'version'
    ]);
    assert.equal((await ctx.journal.read()).phase, 'candidate-present');
  } finally {
    await ctx.cleanup();
  }
});

test('只有 journal、目录名和 owner 全匹配才清理 staging', async () => {
  const ctx = await setup();
  try {
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const destinationPath = path.join(ctx.root, 'restored');
    const owned = await createOwnedStaging({ destinationParent: ctx.root, destinationPath, sessionId });
    await fs.mkdir(owned.candidatePath);
    await fs.writeFile(path.join(owned.candidatePath, 'keep.txt'), 'candidate');
    await ctx.journal.write({
      sessionId, mode: 'restore', ...owned, destinationPath, phase: 'candidate-present'
    });

    const ownerPath = path.join(owned.stagingRoot, OWNER_FILE);
    const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
    await fs.writeFile(ownerPath, JSON.stringify({ ...owner, sessionId: 'different-session' }));
    await assert.rejects(() => ctx.journal.discardOwnedStaging(), /所有权标记不匹配/);
    assert.equal(await fs.readFile(path.join(owned.candidatePath, 'keep.txt'), 'utf8'), 'candidate');
  } finally {
    await ctx.cleanup();
  }
});

test('candidate 已 rename 时只清 journal，永不删除最终目录', async () => {
  const ctx = await setup();
  try {
    const sessionId = '33333333-3333-4333-8333-333333333333';
    const destinationPath = path.join(ctx.root, 'restored');
    const owned = await createOwnedStaging({ destinationParent: ctx.root, destinationPath, sessionId });
    await fs.mkdir(owned.candidatePath);
    await fs.writeFile(path.join(owned.candidatePath, 'note.md'), 'truth');
    await fs.rename(owned.candidatePath, destinationPath);
    await ctx.journal.write({
      sessionId, mode: 'restore', ...owned, destinationPath, phase: 'renamed'
    });

    const result = await ctx.journal.discardOwnedStaging();
    assert.equal(result.destinationPreserved, true);
    assert.equal(result.removed, true);
    assert.equal(await fs.readFile(path.join(destinationPath, 'note.md'), 'utf8'), 'truth');
    await assert.rejects(() => fs.access(owned.stagingRoot));
    assert.equal(await ctx.journal.read(), null);
  } finally {
    await ctx.cleanup();
  }
});

test('wrapper 已清但 journal 未清时只清 journal 并保留 destination', async () => {
  const ctx = await setup();
  try {
    const sessionId = '55555555-5555-4555-8555-555555555555';
    const destinationPath = path.join(ctx.root, 'restored');
    const owned = await createOwnedStaging({ destinationParent: ctx.root, destinationPath, sessionId });
    await fs.mkdir(owned.candidatePath);
    await fs.writeFile(path.join(owned.candidatePath, 'note.md'), 'truth');
    await fs.rename(owned.candidatePath, destinationPath);
    await ctx.journal.write({
      sessionId, mode: 'restore', ...owned, destinationPath, phase: 'renamed'
    });
    await fs.rm(owned.stagingRoot, { recursive: true, force: true });

    const inspected = await ctx.journal.inspect();
    assert.equal(inspected.staleAfterRename, true);
    assert.equal(inspected.owned, false);
    const result = await ctx.journal.discardOwnedStaging();
    assert.equal(result.destinationPreserved, true);
    assert.equal(await fs.readFile(path.join(destinationPath, 'note.md'), 'utf8'), 'truth');
    assert.equal(await ctx.journal.read(), null);
  } finally {
    await ctx.cleanup();
  }
});

test('伪造任意 staging 路径的 journal 视为无效且不删除', async () => {
  const ctx = await setup();
  try {
    const victim = path.join(ctx.root, 'victim');
    await fs.mkdir(victim);
    await fs.writeFile(path.join(victim, 'keep.txt'), 'keep');
    await fs.mkdir(path.dirname(ctx.journal.journalPath), { recursive: true });
    await fs.writeFile(ctx.journal.journalPath, JSON.stringify({
      version: 1,
      sessionId: '44444444-4444-4444-8444-444444444444',
      mode: 'restore',
      stagingRoot: victim,
      destinationPath: path.join(ctx.root, 'destination'),
      phase: 'candidate-present'
    }));

    assert.equal(await ctx.journal.read(), null);
    assert.deepEqual(await ctx.journal.discardOwnedStaging(), { ok: true, absent: true });
    assert.equal(await fs.readFile(path.join(victim, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    await ctx.cleanup();
  }
});
