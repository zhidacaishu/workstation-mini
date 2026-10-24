const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

let electron;
try {
  ({ _electron: electron } = require('playwright-core'));
} catch {}

const projectDir = path.resolve(__dirname, '..');

function monitorRenderer(page, errors) {
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`${page.url()}：${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`${page.url()}：${error.message}`));
}

test('Electron 首次启动提供创建、打开和恢复三个真实入口', {
  skip: !electron && '尚未安装桌面测试依赖',
  timeout: 45_000
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-electron-first-run-'));
  const userDataDir = path.join(root, 'user-data');
  const homeDir = path.join(root, 'home');
  const backupDir = path.join(root, 'backup');
  const destinationParent = path.join(root, 'destinations');
  const destinationDir = path.join(destinationParent, 'recovered-vault');
  const rendererErrors = [];
  let electronApp;

  try {
    await Promise.all([
      fs.mkdir(userDataDir, { recursive: true }),
      fs.mkdir(homeDir, { recursive: true }),
      fs.mkdir(path.join(backupDir, 'notes'), { recursive: true }),
      fs.mkdir(destinationParent, { recursive: true })
    ]);
    const goodNote = '# 恢复后的有效笔记\n\n来源保持不变。\n';
    const badNote = '---\ntitle: [invalid\n---\n\n无法解析。\n';
    const staleDatabase = 'stale derived database';
    await Promise.all([
      fs.writeFile(path.join(backupDir, 'notes', 'good.md'), goodNote, 'utf8'),
      fs.writeFile(path.join(backupDir, 'notes', 'bad.md'), badNote, 'utf8'),
      fs.writeFile(path.join(backupDir, 'workstation.db'), staleDatabase, 'utf8')
    ]);
    const sourceDigests = Object.fromEntries(await Promise.all(
      ['notes/good.md', 'notes/bad.md', 'workstation.db'].map(async relative => [
        relative,
        crypto.createHash('sha256').update(await fs.readFile(path.join(backupDir, ...relative.split('/')))).digest('hex')
      ])
    ));
    const launchEnvironment = {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '1',
      HOME: homeDir,
      USERPROFILE: homeDir
    };
    delete launchEnvironment.ELECTRON_RUN_AS_NODE;

    electronApp = await electron.launch({
      args: [projectDir, `--workstation-user-data=${userDataDir}`],
      env: launchEnvironment
    });
    const recoveryPage = await electronApp.firstWindow();
    monitorRenderer(recoveryPage, rendererErrors);
    await recoveryPage.waitForFunction(() => (
      document.body.dataset.phase === 'idle'
      && !document.getElementById('first-run').hidden
    ));

    assert.match(await recoveryPage.title(), /恢复科研工作台资料库/);
    assert.equal(await recoveryPage.locator('#recovery-form').isHidden(), true);
    assert.deepEqual(
      await recoveryPage.locator('.first-run-actions .choice strong').allInnerTexts(),
      ['创建新资料库', '打开现有资料库', '从备份恢复']
    );

    await recoveryPage.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    const preferences = await recoveryPage.evaluate(() => ({
      canvas: getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim(),
      transitionSeconds: Number.parseFloat(getComputedStyle(document.getElementById('create-vault')).transitionDuration),
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches
    }));
    assert.deepEqual(preferences, {
      canvas: '#1d1b18',
      transitionSeconds: 0.00001,
      dark: true,
      reduced: true
    });
    await recoveryPage.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });

    const dialogCalls = await electronApp.evaluate(({ dialog }) => {
      const calls = [];
      dialog.showOpenDialog = async options => {
        calls.push({
          title: options.title,
          buttonLabel: options.buttonLabel,
          properties: [...options.properties]
        });
        return { canceled: true, filePaths: [] };
      };
      globalThis.__firstRunDialogCalls = calls;
      return calls.length;
    });
    assert.equal(dialogCalls, 0);

    await recoveryPage.click('#create-vault');
    await recoveryPage.waitForFunction(() => !document.getElementById('create-vault').disabled);
    await recoveryPage.click('#open-existing-vault');
    await recoveryPage.waitForFunction(() => !document.getElementById('open-existing-vault').disabled);

    assert.deepEqual(await electronApp.evaluate(() => globalThis.__firstRunDialogCalls), [
      {
        title: '选择或创建科研工作台资料库',
        buttonLabel: '使用此目录',
        properties: ['openDirectory', 'createDirectory']
      },
      {
        title: '选择或创建科研工作台资料库',
        buttonLabel: '使用此目录',
        properties: ['openDirectory', 'createDirectory']
      }
    ]);
    assert.equal(await fs.stat(path.join(userDataDir, 'workstation-data', 'settings.json')).then(() => true, () => false), false);

    await recoveryPage.click('#begin-restore');
    await recoveryPage.waitForFunction(() => (
      document.getElementById('first-run').hidden
      && !document.getElementById('recovery-form').hidden
    ));
    assert.equal(await recoveryPage.locator('#source-panel').isVisible(), true);
    assert.equal(await recoveryPage.locator('#destination-panel').isVisible(), true);
    assert.equal(await recoveryPage.locator('#start').isDisabled(), true);

    await electronApp.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = async (...args) => {
        const options = args.at(-1);
        if (options.title === '选择资料库备份') {
          return { canceled: false, filePaths: [paths.backupDir] };
        }
        if (options.title === '选择新资料库所在位置') {
          return { canceled: false, filePaths: [paths.destinationParent] };
        }
        throw new Error(`未预期的目录选择器：${options.title}`);
      };
    }, { backupDir, destinationParent });

    await recoveryPage.check('input[name="sourceKind"][value="local"]');
    await recoveryPage.click('#choose-local-source');
    await recoveryPage.waitForFunction(expected => (
      document.getElementById('local-source-path').textContent === expected
    ), backupDir);
    await recoveryPage.click('#choose-destination');
    await recoveryPage.waitForFunction(expected => (
      document.getElementById('destination-parent').textContent === expected
    ), destinationParent);
    await recoveryPage.fill('#directory-name', 'recovered-vault');
    await recoveryPage.uncheck('#restore-blobs');
    await recoveryPage.waitForFunction(() => !document.getElementById('start').disabled);
    await recoveryPage.click('#start');
    await recoveryPage.waitForFunction(() => document.body.dataset.phase === 'ready-to-activate');

    assert.equal(await fs.stat(destinationDir).then(() => true, () => false), false);
    assert.equal(await recoveryPage.locator('#outcome').innerText(), '部分恢复');
    assert.match(await recoveryPage.locator('#index-failures').innerText(), /bad\.md.*frontmatter/);
    assert.equal(await recoveryPage.locator('#activate').isVisible(), true);

    const mainPagePromise = electronApp.waitForEvent('window');
    await recoveryPage.click('#activate');
    const mainPage = await mainPagePromise;
    monitorRenderer(mainPage, rendererErrors);
    await mainPage.waitForSelector('.workspace-sidebar');
    await recoveryPage.waitForFunction(() => document.body.dataset.phase === 'completed');
    assert.match(await recoveryPage.locator('#status-message').innerText(), /自动 Git 同步仍关闭/);

    for (const [relative, expected] of Object.entries(sourceDigests)) {
      const actual = crypto.createHash('sha256')
        .update(await fs.readFile(path.join(backupDir, ...relative.split('/'))))
        .digest('hex');
      assert.equal(actual, expected, `来源被修改：${relative}`);
    }
    assert.equal(await fs.readFile(path.join(destinationDir, 'notes', 'good.md'), 'utf8'), goodNote);
    assert.equal(await fs.readFile(path.join(destinationDir, 'notes', 'bad.md'), 'utf8'), badNote);
    assert.notEqual(await fs.readFile(path.join(destinationDir, 'workstation.db'), 'utf8'), staleDatabase);

    const saved = JSON.parse(await fs.readFile(
      path.join(userDataDir, 'workstation-data', 'settings.json'),
      'utf8'
    ));
    assert.equal(path.resolve(saved.vaultDir), path.resolve(destinationDir));
    assert.equal(saved.syncEnabled, false);

    const origin = new URL(mainPage.url()).origin;
    await mainPage.goto(`${origin}/note/good.md`);
    await mainPage.waitForSelector('.prose');
    assert.match(await mainPage.locator('.prose').innerText(), /来源保持不变/);
    await mainPage.waitForFunction(() => !document.getElementById('index-banner').hidden);
    assert.match(await mainPage.locator('#index-banner-message').innerText(), /索引已完成.*1 篇笔记未能更新/);
    assert.match(await mainPage.locator('#index-banner-failures').innerText(), /bad\.md/);

    await fs.writeFile(path.join(destinationDir, 'notes', 'bad.md'), '# 已修复的笔记\n', 'utf8');
    const retryResponse = mainPage.waitForResponse(response => (
      new URL(response.url()).pathname === '/api/index-retry'
      && response.request().method() === 'POST'
    ));
    await mainPage.click('#index-banner-retry');
    assert.equal((await retryResponse).status(), 200);
    await mainPage.waitForFunction(() => (
      document.getElementById('index-banner-message').textContent.includes('索引已恢复')
    ));
    assert.equal(await mainPage.locator('#index-banner-failures').isHidden(), true);
    assert.equal(await mainPage.locator('#index-banner').getAttribute('aria-busy'), null);
    assert.deepEqual(rendererErrors, []);
  } finally {
    if (electronApp) {
      await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await electronApp.close().catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
