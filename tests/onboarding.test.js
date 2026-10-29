const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const request = require('supertest');

const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { createIndexer } = require('../src/vault/indexer');
const { createSearch } = require('../src/search');
const { appendCard } = require('../src/cards');
const { createReviewService } = require('../src/reviewService');
const { onboardingProgress, gitSetupStatus, gitSetupCommands } = require('../src/onboarding');

const FIXED_NOW = new Date(2026, 2, 17, 14, 30);

async function setup(t, { readOnly = false, guide, vaultName = 'vault' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-onboarding-'));
  const vaultDir = path.join(root, vaultName);
  const config = loadConfig({ vaultDir, dbPath: ':memory:', readOnly, syncEnabled: false, device: 'test' });
  await fs.mkdir(config.notesDir, { recursive: true });
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: config.notesDir });
  const search = createSearch(db);
  const review = createReviewService({ vaultDir, device: 'test', now: () => FIXED_NOW });
  const app = createApp(config, { db, indexer, search, guide, now: () => FIXED_NOW });
  t.after(async () => {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  async function write(relative, body) {
    const file = path.join(config.notesDir, ...relative.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
    await indexer.scan();
  }
  const progress = () => onboardingProgress({ db, review, recent: search.recent(8) });
  return { app, db, config, vaultDir, review, write, progress };
}

test('上手清单按资料库实际内容逐步打勾，月历备注不算第一篇笔记', async t => {
  const ctx = await setup(t);
  let progress = await ctx.progress();
  assert.deepEqual(progress.steps.map(step => step.done), [false, false, false, false]);
  assert.equal(progress.next, 'note');
  assert.equal(progress.latestNote, null);

  await ctx.write('calendar/2026-03-17.md', '- [ ] 交周报 @2026-03-18\n');
  progress = await ctx.progress();
  assert.deepEqual(progress.steps.map(step => [step.id, step.done]), [['note', false], ['task', true], ['card', false], ['review', false]]);
  assert.equal(progress.next, 'note');

  await ctx.write('research/attention.md', '# 注意力机制\n\n正文');
  progress = await ctx.progress();
  assert.equal(progress.done, 2);
  assert.equal(progress.next, 'card');
  assert.deepEqual(progress.latestNote, { path: 'research/attention.md', title: '注意力机制' });

  await appendCard(ctx.vaultDir, { deckFile: 'concepts', front: '注意力的复杂度', back: '序列长度的平方' });
  progress = await ctx.progress();
  assert.equal(progress.next, 'review');

  const [card] = await ctx.review.allCards();
  await ctx.review.answer(card.id, 3, 1200, 'first-review');
  progress = await ctx.progress();
  assert.equal(progress.complete, true);
  assert.equal(progress.next, '');
});

test('今日页为新资料库显示上手清单，指向第一步', async t => {
  const ctx = await setup(t);
  const page = await request(ctx.app).get('/').expect(200);
  assert.match(page.text, /data-onboarding-card/);
  assert.match(page.text, /已完成 0 \/ 4/);
  assert.match(page.text, /下一步：写下第一篇笔记/);
  assert.match(page.text, /<a class="button small primary" href="\/new">新建笔记<\/a>/);
  assert.match(page.text, /data-onboarding-hide/);

  await ctx.write('research/a.md', '# 第一篇\n');
  const next = await request(ctx.app).get('/').expect(200);
  assert.match(next.text, /下一步：把一件事写进计划/);
  // 示例截止日取「一周后」，不会写一个已经过去的日期。
  assert.match(next.text, /- \[ \] 读完论文 @2026-03-24/);
});

test('隐藏、全部完成或只读模式时今日页不显示上手清单', async t => {
  const hidden = await setup(t, { guide: { read: () => ({ checklist: 'hidden' }) } });
  assert.doesNotMatch((await request(hidden.app).get('/').expect(200)).text, /data-onboarding-card/);

  const readOnly = await setup(t, { readOnly: true });
  assert.doesNotMatch((await request(readOnly.app).get('/').expect(200)).text, /data-onboarding-card/);

  const broken = await setup(t, { guide: { read: () => { throw new Error('配置目录不可读'); } } });
  assert.match((await request(broken.app).get('/').expect(200)).text, /data-onboarding-card/);

  const done = await setup(t);
  await done.write('research/a.md', '# 笔记\n\n- [x] 已完成的待办\n');
  await appendCard(done.vaultDir, { deckFile: 'concepts', front: '问', back: '答' });
  const [card] = await done.review.allCards();
  await done.review.answer(card.id, 4, 800, 'done-review');
  assert.doesNotMatch((await request(done.app).get('/').expect(200)).text, /data-onboarding-card/);
});

test('上手指南页列出清单、速查和带真实路径的 Git 命令', async t => {
  const ctx = await setup(t, { vaultName: "vault's notes" });
  const page = await request(ctx.app).get('/guide').expect(200);
  assert.match(page.text, /<h1>上手指南<\/h1>/);
  assert.match(page.text, /data-guide-start/);
  for (const id of ['start', 'notes', 'keys', 'plan', 'cards', 'git', 'recover']) {
    assert.match(page.text, new RegExp(`id="${id}"`));
  }
  assert.match(page.text, /开启 Git 版本记录/);
  assert.match(page.text, /data-guide-settings/);
  // 侧栏的问号指向这一页，并标记为当前页。
  assert.match(page.text, /data-nav="guide" class="workspace-tool-link guide-entry is-active" href="\/guide" title="上手指南" aria-label="上手指南" aria-current="page"/);
  // EJS 会转义撇号；还原后应是能直接粘贴进终端的 POSIX 引号。
  const commands = page.text.match(/data-guide-git-commands>([^<]*)</)[1].replaceAll('&#39;', "'").replaceAll('&#34;', '"');
  assert.ok(commands.includes("vault'\"'\"'s notes"));
  assert.doesNotMatch(page.text, /data-onboarding-restore/);
});

test('上手指南页在清单被隐藏时提供恢复入口，只读模式不给写入入口', async t => {
  const hidden = await setup(t, { guide: { read: () => ({ checklist: 'hidden' }) } });
  assert.match((await request(hidden.app).get('/guide').expect(200)).text, /data-onboarding-show/);

  const readOnly = await setup(t, { readOnly: true });
  const page = (await request(readOnly.app).get('/guide').expect(200)).text;
  assert.match(page, /当前是只读模式/);
  assert.doesNotMatch(page, /href="\/new"/);
});

test('Git 命令只列还缺的步骤，路径用 POSIX 引号并统一为正斜杠', () => {
  assert.equal(
    gitSetupCommands('C:\\Users\\张三\\it\'s vault', { isRepository: false, hasIdentity: false }),
    "cd -- 'C:/Users/张三/it'\"'\"'s vault'\ngit init\ngit config user.name \"你的名字\"\ngit config user.email \"你的邮箱\"\ngit status"
  );
  assert.equal(gitSetupCommands('/v', { isRepository: true, hasIdentity: false }),
    "cd -- '/v'\ngit config user.name \"你的名字\"\ngit config user.email \"你的邮箱\"\ngit status");
  assert.equal(gitSetupCommands('/v', { isRepository: false, hasIdentity: true }), "cd -- '/v'\ngit init\ngit status");
});

test('Git 准备情况只读探测仓库、提交身份、远端和同步开关', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-onboarding-git-'));
  const globalConfig = path.join(root, 'empty.gitconfig');
  await fs.writeFile(globalConfig, '');
  const vaultDir = path.join(root, 'vault');
  await fs.mkdir(vaultDir);
  const previous = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
  // 不让测试机自己的全局 Git 身份影响结果。
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  t.after(async () => {
    if (previous.global === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous.global;
    if (previous.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = previous.system;
    await fs.rm(root, { recursive: true, force: true });
  });

  let status = await gitSetupStatus({ vaultDir, syncEnabled: true, readOnly: false });
  assert.equal(status.installed, true);
  assert.equal(status.isRepository, false);
  assert.equal(status.hasIdentity, false);
  assert.equal(status.ready, false);
  await assert.rejects(fs.stat(path.join(vaultDir, '.git')), { code: 'ENOENT' }, '探测不能初始化仓库');

  execFileSync('git', ['init', '-q'], { cwd: vaultDir });
  execFileSync('git', ['config', 'user.name', '测试'], { cwd: vaultDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: vaultDir });
  status = await gitSetupStatus({ vaultDir, syncEnabled: true, readOnly: false });
  assert.deepEqual({ ...status }, {
    installed: true, isRepository: true, hasIdentity: true, hasRemote: false,
    syncEnabled: true, readOnly: false, ready: true
  });

  execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/vault.git'], { cwd: vaultDir });
  assert.equal((await gitSetupStatus({ vaultDir, syncEnabled: true, readOnly: false })).hasRemote, true);
  assert.equal((await gitSetupStatus({ vaultDir, syncEnabled: false, readOnly: false })).ready, false);
  assert.equal((await gitSetupStatus({ vaultDir, syncEnabled: true, readOnly: true })).ready, false);
});
