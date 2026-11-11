const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { _electron: electron } = require('playwright-core');

test('笔记阅读宽度随窗口增长，保持边距与右侧操作对齐', { timeout: 45000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-fluid-reading-'));
  const vault = path.join(root, 'vault');
  const userData = path.join(root, 'user');
  let app, page;
  let passed = false;
  try {
    await fs.mkdir(path.join(vault, 'notes', 'inbox'), { recursive: true });
    await fs.mkdir(path.join(userData, 'workstation-data'), { recursive: true });
    await fs.writeFile(path.join(vault, 'notes', 'inbox', 'plain.md'), '# 流式阅读\n\n正文随窗口展开。\n');
    await fs.writeFile(path.join(vault, 'notes', 'linked.md'), '# 带反向链接\n\n正文\n');
    await fs.writeFile(path.join(vault, 'notes', 'source.md'), '# 来源\n\n[[linked]]\n');
    await fs.writeFile(path.join(userData, 'workstation-data', 'settings.json'), JSON.stringify({ schemaVersion: 1, vaultDir: vault, device: 'fluid-reading', syncEnabled: false }));
    await fs.writeFile(path.join(userData, 'workstation-data', 'guide.json'), JSON.stringify({ version: 2, status: 'completed', step: 6 }));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch(process.env.WORKSTATION_EXECUTABLE
      ? { executablePath: process.env.WORKSTATION_EXECUTABLE, args: ['--workstation-smoke-test', '--workstation-user-data=' + userData], env }
      : { args: [path.resolve(__dirname, '..'), '--workstation-user-data=' + userData], env });
    page = await app.firstWindow();
    await page.waitForSelector('.workspace-sidebar');
    await page.waitForFunction(async () => (await fetch('/api/index-status').then(r => r.json())).phase === 'ready');
    const origin = new URL(page.url()).origin;
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      for (const route of ['/note/inbox/plain.md', '/note/linked.md']) {
        let previousWidth = 0;
        for (const width of [900, 1440, 1920, 2560]) {
          await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http')).setContentSize(width, 800), width);
          await page.goto(origin + route);
          await page.evaluate(() => document.fonts.ready);
          const layout = await page.evaluate(() => {
            const rect = selector => document.querySelector(selector).getBoundingClientRect();
            const main = rect('.page'), rail = rect('.workspace-sidebar'), note = rect('.note'), prose = rect('.prose'), actions = rect('.note-actions');
            const last = document.querySelector('.note-links') || document.querySelector('.note');
            return {
              pageLeft: main.left, railRight: rail.right, pageRight: main.right, viewport: document.documentElement.clientWidth,
              leftGap: note.left - main.left, rightGap: main.right - last.getBoundingClientRect().right,
              noteWidth: note.width, proseWidth: prose.width, actionsRight: actions.right, noteRight: note.right,
              scrollWidth: document.documentElement.scrollWidth
            };
          });
          assert.ok(Math.abs(layout.pageLeft - layout.railRight) < 1, '不保留旧版居中栏的左侧空白');
          assert.ok(Math.abs(layout.pageRight - layout.viewport) < 1, '页面随窗口铺满');
          assert.ok(layout.leftGap >= 28 && layout.leftGap <= 40 && Math.abs(layout.leftGap - layout.rightGap) < 1, '两侧保留对称边距');
          assert.ok(Math.abs(layout.actionsRight - layout.noteRight) < 1, '操作区靠笔记栏右侧');
          assert.ok(Math.abs(layout.proseWidth - layout.noteWidth) < 1, '正文不另设行宽上限');
          assert.ok(layout.proseWidth > previousWidth + 100, '宽窗口中正文继续增长，不停在固定上限');
          assert.ok(layout.scrollWidth <= layout.viewport + 1, '不引入横向溢出');
          previousWidth = layout.proseWidth;
          if (route.includes('/inbox/') && width === 1440) {
            await page.screenshot({ path: path.join(os.tmpdir(), 'workstation-fluid-reading-' + colorScheme + '.png') });
          }
        }
      }
    }
    passed = true;
  } finally {
    if (!passed) {
      await page?.screenshot({ path: path.join(root, 'failure.png'), fullPage: true, timeout: 5000 }).catch(() => {});
      console.error('[fluid-reading] artifacts preserved at ' + root);
    }
    if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
    if (passed) await fs.rm(root, { recursive: true, force: true });
  }
});

test('长项目字段及复习代码在桌面窗口内换行或内部滚动', { timeout: 60000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-layout-desktop-'));
  const vault = path.join(root, 'vault');
  const userData = path.join(root, 'user');
  let app;
  let page;
  let passed = false;
  const errors = [];
  const screenshots = path.join(os.tmpdir(), 'workstation-ui-visual-audit');
  await fs.mkdir(screenshots, { recursive: true });
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
    await fs.writeFile(path.join(userData, 'workstation-data', 'guide.json'), JSON.stringify({ step: 7, status: 'completed' }));
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
          BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('http')).setContentSize(width, 620);
        }, width);
        for (const route of ['/', '/search', '/board/experiment', '/note/experiments/long.md', '/note/research/source.md', '/plan?view=list', '/plan?view=calendar&date=2026-10-25', '/decks', '/review', '/new', '/edit/research/source.md', '/history', '/health', '/guide']) {
          await page.goto(origin + route);
          await page.evaluate(() => document.fonts.ready);
          if (route === '/new') {
            assert.equal(await page.locator('[name=path]').inputValue(), '');
            assert.equal(await page.locator('[data-editor-status]').textContent(), '新笔记尚未保存');
          }
          if (route === '/review') {
            for (const showRelearn of [false, true]) {
              await page.locator('#review-relearn').evaluate((element, show) => { element.hidden = !show; }, showRelearn);
              const controls = await page.locator('.review-tools .review-tool').evaluateAll(elements => elements.map(element => {
                const rect = element.getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(element);
                return {
                  left: rect.left, right: rect.right,
                  inside: [...range.getClientRects()].every(text => text.top >= rect.top && text.bottom <= rect.bottom && text.left >= rect.left && text.right <= rect.right)
                };
              }));
              assert.ok(controls.every(control => control.inside), '长卡组不能挤压操作文字或让文字溢出按钮');
              assert.ok(controls[0].right <= controls[1].left, '复习操作互不覆盖');
              const card = await page.locator('.reviewcard').boundingBox();
              assert.ok(controls.every(control => control.left >= card.x && control.right <= card.x + card.width), '操作完整落在卡片内');
            }
            await page.locator('#review-relearn').evaluate(element => { element.hidden = true; });
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
          await page.waitForSelector('[data-desktop-settings]:not([hidden])');
          const sidebar = await page.locator('.workspace-sidebar').evaluate(rail => {
            const bounds = rail.getBoundingClientRect();
            const controls = [...rail.querySelectorAll('a, button')].filter(e => e.getClientRects().length);
            return {
              width: rail.clientWidth, scrollWidth: rail.scrollWidth, height: rail.clientHeight, scrollHeight: rail.scrollHeight,
              outside: controls.filter(e => { const r = e.getBoundingClientRect(); return r.left < bounds.left || r.right > bounds.right || r.top < 0 || r.bottom > innerHeight; }).map(e => e.getAttribute('aria-label') || e.textContent.trim()),
              footer: [...rail.querySelector('.workspace-sidebar-footer').children].filter(e => e.getClientRects().length).map(e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, top: r.top, bottom: r.bottom }; })
            };
          });
          assert.deepEqual(sidebar.outside, [], route + ': 侧栏按钮必须完整可见');
          assert.ok(sidebar.scrollWidth <= sidebar.width && sidebar.scrollHeight <= sidebar.height + 1, '侧栏无需横向或纵向滚动');
          assert.ok(sidebar.footer.every((r, i, all) => i === 0 || Math.abs(r.x - all[0].x) < 1 && r.top >= all[i - 1].bottom), '底部图标垂直居中且互不覆盖');
          if (width === 900 || width === 1440) {
            const name = route === '/' ? 'today' : route.replace(/[^a-zA-Z0-9]/g, '-');
            await page.screenshot({ path: path.join(screenshots, colorScheme + '-' + width + '-' + name + '.png') });
          }
          // clientWidth 不含纵向滚动条：Windows/Linux 的滚动条占宽，用 innerWidth 比会漏掉横向滚动条。
          const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
          assert.ok(layout.scrollWidth <= layout.width + 1,
            colorScheme + ' ' + width + 'px ' + route + ': 页面被撑至 ' + layout.scrollWidth + 'px');
        }
      }
    }
    // Native title-bar layout uses the same rail without macOS inset padding.
    await page.goto(origin + '/new');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http')).setContentSize(900, 620));
    await page.evaluate(() => document.documentElement.classList.remove('chrome-inset'));
    assert.equal(await page.locator('.workspace-sidebar').evaluate(e => e.scrollHeight <= e.clientHeight + 1 && e.scrollWidth <= e.clientWidth), true);
    await page.screenshot({ path: path.join(screenshots, 'native-titlebar-900-new.png') });
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
      await settingsPage.screenshot({ path: path.join(screenshots, 'settings-' + theme + '.png'), fullPage: true });
      assert.equal(page.url(), editorUrl);
      assert.equal(await page.locator('[name="body"]').inputValue(), draft);
    }
    const recoveryOpened = app.waitForEvent('window');
    await settingsPage.locator('#open-recovery').click();
    const recoveryPage = await recoveryOpened;
    await recoveryPage.waitForLoadState('domcontentloaded');
    for (const scheme of ['light', 'dark']) {
      await recoveryPage.emulateMedia({ colorScheme: scheme });
      await recoveryPage.screenshot({ path: path.join(screenshots, 'recovery-' + scheme + '.png'), fullPage: true });
      assert.equal(await recoveryPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    }
    await recoveryPage.close();
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
