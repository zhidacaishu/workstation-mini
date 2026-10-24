const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { _electron: electron } = require('playwright-core');

test('draft survives restart; history restores deleted note; tasks edit source in real renderer', { timeout: 60000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-history-desktop-'));
  const vault = path.join(root, 'vault');
  const userData = path.join(root, 'user');
  const settings = path.join(userData, 'workstation-data');
  let app;
  try {
    await fs.mkdir(path.join(vault, 'notes'), { recursive: true });
    await fs.mkdir(settings, { recursive: true });
    await fs.writeFile(path.join(vault, 'notes', 'task.md'), '# Task\n\n- [ ] write paper @2026-10-05\n');
    await fs.writeFile(path.join(settings, 'settings.json'), JSON.stringify({
      schemaVersion: 1, vaultDir: vault, device: 'history-smoke', syncEnabled: false, secrets: {}
    }));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const launch = () => electron.launch(process.env.WORKSTATION_EXECUTABLE
      ? { executablePath: process.env.WORKSTATION_EXECUTABLE, args: ['--workstation-smoke-test', '--workstation-user-data=' + userData], env }
      : { args: [path.resolve(__dirname, '..'), '--workstation-user-data=' + userData], env });
    app = await launch();
    let page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.workspace-sidebar');
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let origin = new URL(page.url()).origin;
    await page.goto(origin + '/edit/task.md');
    await page.locator('[name="body"]').fill('# My recovered draft\n\n- [ ] write paper @2026-10-05\n');
    await page.waitForFunction(() => document.querySelector('[data-draft-status]').textContent.includes('草稿已保存在本机'));
    // Exit without unload handling, as in a process crash after autosave.
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    app = await launch();
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.workspace-sidebar');
    page.on('pageerror', error => errors.push(error.message));
    origin = new URL(page.url()).origin;
    await page.goto(origin + '/history', { waitUntil: 'domcontentloaded' });
    await page.locator('main .notelist a').first().click();
    assert.match(await page.locator('.history-preview').innerText(), /My recovered draft/);
    await page.getByRole('link', { name: '载入编辑器', exact: true }).click();
    assert.match(await page.locator('[name="body"]').inputValue(), /My recovered draft/);
    assert.match(await page.locator('[data-editor-status]').innerText(), /未保存/);
    await page.locator('[data-editor-save]').click();
    await page.waitForURL('**/note/task.md');
    await page.goto(origin + '/tasks');
    const task = page.locator('[data-task-form]').first();
    await task.locator('[name="done"]').check();
    await task.locator('[name="due"]').fill('2026-10-08');
    await task.locator('button').click();
    await page.waitForFunction(() => document.querySelector('.empty')?.textContent.includes('没有未完成'));
    assert.match(await fs.readFile(path.join(vault, 'notes', 'task.md'), 'utf8'), /- \[x\] write paper @2026-10-08/);
    await page.goto(origin + '/note/task.md');
    await page.locator('.note-more summary').click();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-confirm-delete] button').click();
    await page.waitForURL(origin + '/');
    await page.goto(origin + '/history', { waitUntil: 'domcontentloaded' });
    const deleted = page.locator('main .notelist li').filter({ hasText: '已删除' });
    await deleted.locator('a').click();
    await page.getByRole('link', { name: '载入编辑器', exact: true }).click();
    await page.locator('[data-editor-save]').click();
    await page.waitForURL('**/note/task.md');
    assert.match(await fs.readFile(path.join(vault, 'notes', 'task.md'), 'utf8'), /My recovered draft/);
    assert.deepEqual(errors, []);
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
