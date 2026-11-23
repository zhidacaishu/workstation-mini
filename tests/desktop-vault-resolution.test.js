const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveVaultDir } = require('../electron/vault-resolution');

const SAVED = 'D:\\移动硬盘\\vault';
const CONVENTIONAL = 'C:\\Users\\henry\\workstation-vault';
const PICKED = 'E:\\另一个\\vault';

/**
 * 按剧本作答的假对话框。
 *
 * answers / picks 依次消费；用光还被问到就是逻辑跑飞了（多半是死循环），
 * 直接抛错而不是继续喂默认值 —— 后者会把死循环伪装成通过的测试。
 */
function scripted({ existing = [], answers = [], picks = [] } = {}) {
  const present = new Set(existing);
  const asked = [];
  const prompted = [];
  const pendingAnswers = [...answers];
  const pendingPicks = [...picks];

  return {
    asked,
    prompted,
    present,
    ports: {
      pathExists: target => present.has(target),
      askMissingVault: async missingPath => {
        asked.push(missingPath);
        if (pendingAnswers.length === 0) throw new Error('对话框被多问了一次');
        return pendingAnswers.shift();
      },
      promptForDirectory: async purpose => {
        prompted.push(purpose);
        if (pendingPicks.length === 0) throw new Error('目录选择器被多开了一次');
        return pendingPicks.shift();
      }
    }
  };
}

function resolve(fixture, overrides = {}) {
  return resolveVaultDir({
    savedVaultDir: SAVED,
    conventionalVaultDir: CONVENTIONAL,
    ...fixture.ports,
    ...overrides
  });
}

test('已保存的资料库还在时直接使用，不打扰用户', async () => {
  const fixture = scripted({ existing: [SAVED, CONVENTIONAL] });
  assert.deepEqual(await resolve(fixture), { vaultDir: SAVED });
  assert.deepEqual(fixture.asked, []);
  assert.deepEqual(fixture.prompted, []);
});

test('从未保存过资料库时认约定位置', async () => {
  const fixture = scripted({ existing: [CONVENTIONAL] });
  const result = await resolve(fixture, { savedVaultDir: '' });
  assert.deepEqual(result, { vaultDir: CONVENTIONAL });
  assert.deepEqual(fixture.prompted, [], '约定位置在就不该弹选择器');
});

test('从未保存过且约定位置也没有时进入明确的首次启动流程', async () => {
  const fixture = scripted();
  assert.deepEqual(await resolve(fixture, { savedVaultDir: '' }), { firstRun: true });
  assert.deepEqual(fixture.prompted, []);
});

// 这条是整个模块存在的理由：开机自启时移动硬盘、网络位置和云盘经常还没就绪，
// 自动退回约定目录会让笔记写进错的资料库，并把它推到错的远端 —— 且毫无提示。
test('已保存的资料库不可用时绝不静默退回约定目录', async () => {
  const fixture = scripted({ existing: [CONVENTIONAL], answers: ['quit'] });
  assert.deepEqual(await resolve(fixture), { quit: true });
  assert.deepEqual(fixture.asked, [SAVED], '应该就着缺失的那个路径发问');
});

test('已保存资料库缺失时可明确进入恢复，且原路径随意图保留', async () => {
  const fixture = scripted({ answers: ['restore'] });
  assert.deepEqual(await resolve(fixture), { restore: true, missingVaultDir: SAVED });
  assert.deepEqual(fixture.prompted, []);
});

test('重试时目录已恢复就用回原来的资料库', async () => {
  const fixture = scripted({ answers: ['retry'] });
  const promise = resolve(fixture);
  fixture.present.add(SAVED); // 用户在对话框开着的时候插上了硬盘
  assert.deepEqual(await promise, { vaultDir: SAVED });
});

test('重试后目录仍然不在就继续问，不做任何默认动作', async () => {
  const fixture = scripted({ answers: ['retry', 'retry', 'quit'] });
  assert.deepEqual(await resolve(fixture), { quit: true });
  assert.equal(fixture.asked.length, 3);
});

test('另选目录会采用新路径', async () => {
  const fixture = scripted({ answers: ['choose'], picks: [PICKED] });
  assert.deepEqual(await resolve(fixture), { vaultDir: PICKED });
  assert.deepEqual(fixture.prompted, ['replace']);
});

// 「另选目录」点开又取消，必须回到三选一。掉出循环的话就只剩「返回空路径」
// 一种表达，而那正是把已保存配置清空的老毛病。
test('另选目录又取消时回到询问，绝不返回空路径', async () => {
  const fixture = scripted({ answers: ['choose', 'quit'], picks: [''] });
  assert.deepEqual(await resolve(fixture), { quit: true });
  assert.equal(fixture.asked.length, 2);
});

test('意料之外的答复按重试处理，不会悄悄换库', async () => {
  const fixture = scripted({ existing: [CONVENTIONAL], answers: [undefined, 'quit'] });
  assert.deepEqual(await resolve(fixture), { quit: true });
  assert.equal(fixture.asked.length, 2);
});

test('已保存路径的首尾空白不影响判断', async () => {
  const fixture = scripted({ existing: [SAVED] });
  assert.deepEqual(await resolve(fixture, { savedVaultDir: `  ${SAVED}  ` }), { vaultDir: SAVED });
});

test('用户明确要重新选择资料库时不认约定位置，进入首次启动的选择流程', async () => {
  const fixture = scripted({ existing: [CONVENTIONAL] });
  assert.deepEqual(await resolve(fixture, { savedVaultDir: '', chooseExplicitly: true }), { firstRun: true });
  assert.deepEqual(fixture.asked, []);
});

test('设置文件损坏后选「重新选择资料库」会让启动流程走明确的选择', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.match(main, /if \(choice === 1\) \{[\s\S]*?chooseVaultExplicitly = true;/);
  assert.match(main, /chooseExplicitly: chooseVaultExplicitly/);
});

// ---------- 设置里换资料库 ----------

test('设置里手打的资料库路径不存在或不是资料库时拒绝，不会悄悄建一个空库', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { checkVaultChange } = require('../electron/vault-change');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-vault-change-'));
  try {
    const current = path.join(root, 'current');
    const vault = path.join(root, 'vault');
    const empty = path.join(root, 'empty');
    fs.mkdirSync(path.join(current, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(vault, 'notes'), { recursive: true });
    fs.mkdirSync(empty);
    fs.writeFileSync(path.join(root, 'file.txt'), 'x');
    const check = (nextVaultDir, pickedDirs) => checkVaultChange({ previousVaultDir: current, nextVaultDir, pickedDirs });

    await assert.rejects(check(path.join(root, 'typo')), /资料库目录不存在/);
    await assert.rejects(check(path.join(root, 'file.txt')), /不是目录/);
    await assert.rejects(check(empty), /不像资料库/);
    await check(vault);
    await check(empty, new Set([empty]));
    // 正常用法不能被误拒：资料库是指向云盘的符号链接、.git 是文件（worktree）、还没有 notes/。
    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
    await check(worktree);
    const cardsOnly = path.join(root, 'cards-only');
    fs.mkdirSync(path.join(cardsOnly, 'cards'), { recursive: true });
    await check(cardsOnly);
    if (process.platform !== 'win32') {
      const link = path.join(root, 'linked-vault');
      fs.symlinkSync(vault, link);
      await check(link);
    }
    // 路径没变（哪怕资料库暂时不在）时不挡别的设置。
    await checkVaultChange({ previousVaultDir: path.join(root, 'gone'), nextVaultDir: path.join(root, 'gone') + path.sep });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('保存设置换资料库前先检查目录，选择框挑过的目录可以是新建的空目录', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const save = main.slice(main.indexOf("ipcMain.handle('settings:save'"), main.indexOf("ipcMain.handle('settings:choose-directory'"));
  assert.match(save, /await checkVaultChange\(\{[\s\S]*?pickedDirs: pickedVaultDirs/);
  assert.ok(save.indexOf('checkVaultChange') < save.indexOf('replaceRuntime(next, previous)'));
  const choose = main.slice(main.indexOf("ipcMain.handle('settings:choose-directory'"));
  assert.match(choose.slice(0, 800), /pickedVaultDirs\.add\(/);
});
