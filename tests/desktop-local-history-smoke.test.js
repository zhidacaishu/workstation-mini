const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { _electron: electron } = require('playwright-core');

test('draft survives restart; history restores deleted note; tasks edit source in real renderer', { timeout: 90000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-history-desktop-'));
  const vault = path.join(root, 'vault');
  const userData = path.join(root, 'user');
  const settings = path.join(userData, 'workstation-data');
  let app;
  let passed = false;
  const phases = [];
  const errors = [];
  let page;
  async function phase(name, operation) {
    const started = Date.now();
    phases.push({ name, startedAt: new Date(started).toISOString(), status: 'running' });
    console.log('[desktop-smoke] phase=' + name + ' start');
    try {
      const result = await operation();
      const entry = phases.at(-1);
      Object.assign(entry, { status: 'done', durationMs: Date.now() - started });
      console.log('[desktop-smoke] phase=' + name + ' done durationMs=' + entry.durationMs);
      return result;
    } catch (error) {
      const entry = phases.at(-1);
      Object.assign(entry, { status: 'failed', durationMs: Date.now() - started, error: error.message });
      console.error('[desktop-smoke] phase=' + name + ' failed durationMs=' + entry.durationMs + ': ' + error.message);
      throw error;
    }
  }
  try {
    await phase('prepare-fixture', async () => {
      await fs.mkdir(path.join(vault, 'notes'), { recursive: true });
      await fs.mkdir(settings, { recursive: true });
      await fs.writeFile(path.join(vault, 'notes', 'task.md'), '# Task\n\n- [ ] write paper @2026-10-05\n');
      await fs.writeFile(path.join(settings, 'guide.json'), JSON.stringify({ step: 7, status: 'completed' }));
      await fs.writeFile(path.join(settings, 'settings.json'), JSON.stringify({
      schemaVersion: 1, vaultDir: vault, device: 'history-smoke', syncEnabled: false
      }));
    });
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const launch = () => electron.launch(process.env.WORKSTATION_EXECUTABLE
      ? { executablePath: process.env.WORKSTATION_EXECUTABLE, args: ['--workstation-smoke-test', '--workstation-user-data=' + userData], env }
      : { args: [path.resolve(__dirname, '..'), '--workstation-user-data=' + userData], env });
    app = await phase('launch-first', launch);
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    await page.waitForSelector('.workspace-sidebar', { timeout: 15000 });
    page.on('pageerror', error => errors.push(error.message));
    let origin = new URL(page.url()).origin;
    await phase('verify-simplified-settings-and-recovery', async () => {
      const settingsOpened = app.waitForEvent('window');
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('show-settings').click());
      const settingsPage = await settingsOpened;
      await settingsPage.waitForLoadState('domcontentloaded');
      assert.equal(await settingsPage.locator('#ai, [name="anthropicApiKey"]').count(), 0);
      const recoveryOpened = app.waitForEvent('window');
      await settingsPage.locator('#open-recovery').click();
      const recoveryPage = await recoveryOpened;
      await recoveryPage.waitForLoadState('domcontentloaded');
      assert.equal(await recoveryPage.locator('#restore-blobs, [data-stage="blobs"]').count(), 0);
      assert.equal(await recoveryPage.locator('#stages li').count(), 4);
      if (process.env.WORKSTATION_VISUAL_OUTPUT) {
        await fs.mkdir(process.env.WORKSTATION_VISUAL_OUTPUT, { recursive: true });
        await recoveryPage.screenshot({ path: path.join(process.env.WORKSTATION_VISUAL_OUTPUT, 'history-recovery.png') });
      }
      await recoveryPage.close();
      await settingsPage.close();
    });
    await phase('autosave-draft', async () => {
      await page.goto(origin + '/edit/task.md', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.locator('[name="body"]').fill('# My recovered draft\n\n- [ ] write paper @2026-10-05\n');
      await page.waitForFunction(() => document.querySelector('[data-draft-status]')?.textContent.includes('草稿已保存在本机'), null, { timeout: 10000 });
    });
    // Exit without unload handling, as in a process crash after autosave.
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    app = await phase('restart', launch);
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    await page.waitForSelector('.workspace-sidebar', { timeout: 15000 });
    page.on('pageerror', error => errors.push(error.message));
    origin = new URL(page.url()).origin;
    await phase('restore-draft', async () => {
      await page.goto(origin + '/history', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.locator('main .notelist a').first().click();
      assert.match(await page.locator('.history-preview').innerText(), /My recovered draft/);
      await page.getByRole('link', { name: '载入编辑器', exact: true }).click();
      assert.match(await page.locator('[name="body"]').inputValue(), /My recovered draft/);
      // 恢复页载入后不算「有未保存的更改」（不改也能离开），但会说明还没写进笔记。
      assert.match(await page.locator('[data-editor-status]').innerText(), /保存后才会写入笔记/);
      await page.locator('[data-editor-save]').click();
      await page.waitForURL('**/note/task.md', { timeout: 15000 });
    });
    await phase('edit-task', async () => {
      await page.goto(origin + '/tasks', { waitUntil: 'domcontentloaded', timeout: 15000 });
      const task = page.locator('[data-task-form]').first();
      await task.locator('[name="due"]').fill('2026-10-08');
      await task.locator('button').click();
      await page.waitForFunction(() => document.querySelector('[data-task-form] [name="due"]')?.value === '2026-10-08'
        && !document.querySelector('[data-task-form]')?.hasAttribute('aria-busy'));
      await page.locator('[data-task-form]').first().locator('[name="done"]').check();
      await page.waitForFunction(() => document.querySelector('.empty')?.textContent.includes('没有未完成'), null, { timeout: 10000 });
    });
    assert.match(await fs.readFile(path.join(vault, 'notes', 'task.md'), 'utf8'), /- \[x\] write paper @2026-10-08/);
    await phase('delete-note', async () => {
      await page.goto(origin + '/note/task.md', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.locator('.note-more summary').click();
      page.once('dialog', dialog => dialog.accept());
      await page.locator('[data-confirm-delete] button').click();
      // 删除后回到笔记列表（分区笔记回到该分区的列表）。
      await page.waitForURL(origin + '/search', { timeout: 15000 });
    });
    await phase('restore-deleted-note', async () => {
      await page.goto(origin + '/history', { waitUntil: 'domcontentloaded', timeout: 15000 });
      const deleted = page.locator('main .notelist li').filter({ hasText: '已删除' });
      await deleted.locator('a').click();
      await page.getByRole('link', { name: '载入编辑器', exact: true }).click();
      await page.locator('[data-editor-save]').click();
      await page.waitForURL('**/note/task.md', { timeout: 15000 });
    });
    assert.match(await fs.readFile(path.join(vault, 'notes', 'task.md'), 'utf8'), /My recovered draft/);
    assert.deepEqual(errors, []);
    passed = true;
  } finally {
    if (!passed) {
      const diagnostics = { root, phases, url: page?.url?.() || '', errors };
      try { diagnostics.bodyText = await page?.locator('body').innerText({ timeout: 2000 }); } catch {}
      try { await page?.screenshot({ path: path.join(root, 'page.png'), fullPage: true, timeout: 5000 }); diagnostics.screenshot = path.join(root, 'page.png'); } catch {}
      await fs.writeFile(path.join(root, 'smoke-diagnostics.json'), JSON.stringify(diagnostics, null, 2)).catch(error => console.error('[desktop-smoke] diagnostics write failed: ' + error.message));
      console.error('[desktop-smoke] failure artifacts preserved at ' + root);
    }
    if (app) {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    }
    if (passed) {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
