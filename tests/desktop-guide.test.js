const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { _electron: electron } = require('playwright-core');

test('页面新手指引：首次显示、进度、Git 设置、跳过和重启', { timeout: 60000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-guide-desktop-'));
  const userData = path.join(root, 'user');
  const vault = path.join(root, "vault's notes");
  let app, page, passed = false;
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => electron.launch({ args: [path.resolve(__dirname, '..'), '--workstation-user-data=' + userData], env });
  async function close() { await app.evaluate(({ app }) => app.exit(0)); await app.close().catch(() => {}); app = null; }
  try {
    await fs.mkdir(path.join(vault, 'notes'), { recursive: true });
    await fs.mkdir(path.join(userData, 'workstation-data'), { recursive: true });
    await fs.writeFile(path.join(vault, 'notes', 'test.md'), '# 笔记\n\n原内容');
    const configFile = path.join(userData, 'workstation-data', 'settings.json');
    await fs.writeFile(configFile, JSON.stringify({ schemaVersion: 5, vaultDir: vault, syncEnabled: false, device: 'guide' }));
    app = await launch(); page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.waitForSelector('#onboarding[open]');
    assert.match(await page.locator('#guide-title').textContent(), /先认识/);
    assert.equal(await page.locator('[data-guide-prev]').isDisabled(), true);
    for (let i = 0; i < 3; i++) {
      await page.locator('[data-guide-next]').click();
      await page.waitForFunction(step => document.querySelector('[data-guide-progress]').textContent === step + ' / 8', i + 2);
    }
    await page.reload();
    await page.waitForSelector('#onboarding[open]');
    assert.match(await page.locator('#guide-title').textContent(), /计划/);
    await page.locator('[data-guide-prev]').click();
    assert.match(await page.locator('#guide-title').textContent(), /找回/);
    for (let i = 0; i < 3; i++) {
      await page.locator('[data-guide-next]').click();
      await page.waitForFunction(step => document.querySelector('[data-guide-progress]').textContent === step + ' / 8', i + 4);
    }
    assert.match(await page.locator('#guide-title').textContent(), /先准备/);
    const commands = await page.locator('[data-guide-git-commands]').textContent();
    assert.ok(commands.includes("vault'\"'\"'s notes"));
    assert.match(commands, /git init/);
    assert.match(commands, /git config user.name/);
    await page.setViewportSize({ width: 900, height: 620 });
    for (const scheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: scheme });
      assert.ok(await page.locator('[data-guide-skip]').isVisible());
      assert.notEqual(await page.locator('#onboarding').evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)');
      await page.locator('[data-guide-next]').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('#onboarding').evaluate(e => e.scrollWidth <= e.clientWidth), true);
    }
    await page.screenshot({ path: '/tmp/workstation-guide-git.png' });
    await page.locator('[data-guide-next]').click();
    assert.match(await page.locator('#guide-title').textContent(), /保存同步设置/);
    const newWindow = app.waitForEvent('window');
    await page.locator('[data-guide-settings]').click();
    const settings = await newWindow;
    await settings.waitForSelector('#settings-form');
    assert.equal(await settings.locator('[name=syncEnabled]').isChecked(), false);
    await settings.close();
    await page.locator('[data-guide-skip]').click();
    await page.waitForSelector('#onboarding', { state: 'hidden' });
    await page.reload();
    assert.equal(await page.locator('#onboarding').isVisible(), false);
    await close();
    app = await launch(); page = await app.firstWindow();
    await page.waitForSelector('.workspace-sidebar');
    await page.waitForFunction(() => Boolean(window.workstationDesktop));
    const saved = await page.evaluate(() => window.workstationDesktop.getGuide());
    assert.equal(saved.status, 'skipped');
    assert.equal(await page.locator('#onboarding').isVisible(), false);
    await page.locator('[data-guide-open]').click();
    await page.waitForSelector('#onboarding[open]');
    assert.match(await page.locator('#guide-title').textContent(), /先认识/);
    for (let i = 0; i < 7; i++) {
      await page.locator('[data-guide-next]').click();
      await page.waitForFunction(step => document.querySelector('[data-guide-progress]').textContent === step + ' / 8', i + 2);
    }
    await page.getByRole('button', { name: '完成指引', exact: true }).click();
    await page.waitForSelector('#onboarding', { state: 'hidden' });
    assert.equal((await page.evaluate(() => window.workstationDesktop.getGuide())).status, 'completed');
    await page.locator('[data-guide-open]').click();
    await page.waitForSelector('#onboarding[open]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#onboarding', { state: 'hidden' });
    assert.equal(await page.locator('[data-guide-open]').evaluate(e => e === document.activeElement), true);
    const origin = new URL(page.url()).origin;
    await page.evaluate(() => window.workstationDesktop.saveGuide({ step: 1, status: 'active' }));
    await page.goto(origin + '/edit/test.md');
    assert.equal(await page.locator('#onboarding').isVisible(), false, '编辑时不得自动打断');
    assert.equal(JSON.parse(await fs.readFile(configFile)).syncEnabled, false);
    await assert.rejects(fs.stat(path.join(vault, '.git')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(vault, 'notes', 'test.md'), 'utf8'), '# 笔记\n\n原内容');
    assert.deepEqual(errors, []);
    passed = true;
  } finally {
    if (!passed) { console.error(root); await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); }
    if (app) await close().catch(() => {});
    if (passed) await fs.rm(root, { recursive: true, force: true });
  }
});
