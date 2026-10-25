const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { _electron: electron } = require('playwright-core');

test('长项目字段及复习代码在桌面窗口内换行或内部滚动', { timeout: 60000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-layout-desktop-'));
  const vault = path.join(root, 'vault');
  const userData = path.join(root, 'user');
  let app;
  let page;
  let passed = false;
  const errors = [];
  try {
    await fs.mkdir(path.join(vault, 'notes', 'experiments'), { recursive: true });
    await fs.mkdir(path.join(vault, 'notes', 'research'), { recursive: true });
    await fs.mkdir(path.join(vault, 'cards'), { recursive: true });
    await fs.mkdir(path.join(userData, 'workstation-data'), { recursive: true });
    const token = 'LongModelIdentifier'.repeat(12);
    await fs.writeFile(path.join(vault, 'notes', 'experiments', 'long.md'), [
      '---', 'title: ' + token, 'status: running', 'dataset: ' + token,
      'params: ' + token, 'seed: 42', 'commit: ' + token, 'next: ' + token,
      'result: ' + token, 'deadline: 2026-10-25', '---', '', '[[research/source]]'
    ].join('\n'));
    await fs.writeFile(path.join(vault, 'notes', 'research', 'source.md'),
      ['---', 'title: ' + token, 'tags: [' + token + ']', '---', '', '[[experiments/long]]', '', '- [ ] ' + token + ' @2026-10-25'].join('\n'));
    const code = 'x'.repeat(230);
    const fence = String.fromCharCode(96).repeat(3);
    await fs.writeFile(path.join(vault, 'cards', 'layout.md'), [
      '---', 'deck: ' + token, '---', '', '## ' + token, '',
      'https://example.com/' + token, '', fence + 'python', code, fence, '',
      '| column |', '| --- |', '| ' + token + ' |', '', '- [ ] unfinished', '- [x] finished'
    ].join('\n'));
    await fs.writeFile(path.join(userData, 'workstation-data', 'settings.json'), JSON.stringify({
      schemaVersion: 1, vaultDir: vault, device: 'layout-smoke', syncEnabled: false
    }));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch(process.env.WORKSTATION_EXECUTABLE
      ? { executablePath: process.env.WORKSTATION_EXECUTABLE, args: ['--workstation-smoke-test', '--workstation-user-data=' + userData], env }
      : { args: [path.resolve(__dirname, '..'), '--workstation-user-data=' + userData], env });
    page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('.workspace-sidebar');
    await page.waitForFunction(async () => (await fetch('/api/index-status').then(response => response.json())).phase === 'ready');
    const origin = new URL(page.url()).origin;
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      for (const width of [900, 1100, 1440]) {
        await app.evaluate(({ BrowserWindow }, width) => {
          BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('http')).setContentSize(width, 650);
        }, width);
        for (const route of ['/', '/search', '/board/experiment', '/note/experiments/long.md', '/note/research/source.md', '/plan?view=list', '/plan?view=calendar&date=2026-10-25', '/decks', '/review']) {
          await page.goto(origin + route);
          await page.evaluate(() => document.fonts.ready);
          if (route === '/review') {
            await page.locator('#review-reveal').click();
            const block = await page.locator('.review-back pre').evaluate(element => ({
              overflow: getComputedStyle(element).overflowX, width: element.clientWidth, scrollWidth: element.scrollWidth,
              content: element.textContent.trim()
            }));
            assert.equal(block.overflow, 'auto');
            assert.ok(block.scrollWidth > block.width, '长代码保留完整行并可以内部横向滚动');
            assert.equal(block.content, code);
            const taskBoxes = await page.locator('.review-back .task-box').evaluateAll(elements =>
              elements.map(element => ({ width: element.getBoundingClientRect().width, label: element.getAttribute('aria-label') })));
            assert.deepEqual(taskBoxes.map(box => box.label), ['待办', '已完成']);
            assert.ok(taskBoxes.every(box => box.width >= 15), '复习卡片中的待办状态框必须可见');
          }
          if (route === '/decks') {
            const action = await page.locator('.deck-action a').boundingBox();
            assert.ok(action && action.x + action.width <= await page.evaluate(() => innerWidth), '长卡组名不能隐藏复习操作');
          }
          const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
          assert.ok(layout.scrollWidth <= layout.width + 1,
            colorScheme + ' ' + width + 'px ' + route + ': 页面被撑至 ' + layout.scrollWidth + 'px');
        }
      }
    }
    await page.goto(origin + '/edit/research/source.md');
    const draft = '尚未保存的主题切换验证';
    await page.locator('[name="body"]').fill(draft);
    const editorUrl = page.url();
    const opened = app.waitForEvent('window');
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('show-settings').click());
    const settingsPage = await opened;
    await settingsPage.waitForSelector('body[data-settings-state="clean"]');
    for (const theme of ['dark', 'light', 'system']) {
      await settingsPage.locator('.theme-switch label').filter({
        has: settingsPage.locator('input[value="' + theme + '"]')
      }).click();
      await settingsPage.locator('#save').click();
      await settingsPage.waitForFunction(() => document.querySelector('#message').textContent === '设置已保存。');
      assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), theme);
      assert.equal((await settingsPage.evaluate(() => window.workstationSettings.get())).settings.theme, theme);
      assert.equal(page.url(), editorUrl);
      assert.equal(await page.locator('[name="body"]').inputValue(), draft);
    }
    assert.deepEqual(errors, []);
    passed = true;
  } finally {
    if (!passed) {
      await page?.screenshot({ path: path.join(root, 'failure.png'), fullPage: true, timeout: 5000 }).catch(() => {});
      console.error('[desktop-layout] failure artifacts preserved at ' + root);
    }
    if (app) {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    }
    if (passed) await fs.rm(root, { recursive: true, force: true });
  }
});
