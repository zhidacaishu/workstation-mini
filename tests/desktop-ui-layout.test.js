const test = require('node:test');
const { waitForApi } = require('./desktop-test-utils');
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
    await waitForApi(page, '/api/index-status', status => status.phase === 'ready');
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
          if (process.env.WORKSTATION_VISUAL_OUTPUT && route.includes('/inbox/') && width === 1440) {
            await fs.mkdir(process.env.WORKSTATION_VISUAL_OUTPUT, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WORKSTATION_VISUAL_OUTPUT, 'fluid-reading-' + colorScheme + '.png') });
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
  const screenshots = process.env.WORKSTATION_VISUAL_OUTPUT || path.join(os.tmpdir(), 'workstation-ui-visual-audit');
  await fs.mkdir(screenshots, { recursive: true });
  try {
    await fs.mkdir(path.join(vault, 'notes', 'experiments'), { recursive: true });
    await fs.mkdir(path.join(vault, 'notes', 'research'), { recursive: true });
    await fs.mkdir(path.join(vault, 'cards'), { recursive: true });
    await fs.mkdir(path.join(userData, 'workstation-data'), { recursive: true });
    const longSection = 'multicenter_validation_'.repeat(5);
    await fs.mkdir(path.join(vault, 'notes', longSection));
    await fs.writeFile(path.join(vault, 'notes', longSection, 'study.md'), '# 队列研究记录');
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
    await waitForApi(page, '/api/index-status', status => status.phase === 'ready');
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
            // 「撤销上一张」评过分才出现：有它没它两种情况都量一遍。
            for (const [showRelearn, showUndo] of [[false, false], [true, false], [false, true], [true, true]]) {
              await page.locator('#review-relearn').evaluate((element, show) => { element.hidden = !show; }, showRelearn);
              await page.locator('#review-undo').evaluate((element, show) => { element.hidden = !show; }, showUndo);
              const controls = await page.locator('.review-tools .review-tool:not([hidden])').evaluateAll(elements => elements.map(element => {
                const rect = element.getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(element);
                return {
                  left: rect.left, right: rect.right,
                  inside: [...range.getClientRects()].every(text => text.top >= rect.top && text.bottom <= rect.bottom && text.left >= rect.left && text.right <= rect.right)
                };
              }));
              assert.ok(controls.every(control => control.inside), '长卡组不能挤压操作文字或让文字溢出按钮');
              assert.equal(controls.length, showUndo ? 3 : 2);
              assert.ok(controls.every((control, index) => index === 0 || controls[index - 1].right <= control.left), '复习操作互不覆盖');
              const card = await page.locator('.reviewcard').boundingBox();
              assert.ok(controls.every(control => control.left >= card.x && control.right <= card.x + card.width), '操作完整落在卡片内');
            }
            await page.locator('#review-relearn').evaluate(element => { element.hidden = true; });
            await page.locator('#review-undo').evaluate(element => { element.hidden = true; });
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
          if (route === '/search') {
            const row = page.locator('.library-document').filter({ hasText: '队列研究记录' });
            assert.ok(await row.locator('.library-document-content').evaluate(el => el.clientWidth > 150));
            assert.equal(await row.locator('[title="' + longSection + '"]').evaluate(el => el.scrollWidth > el.clientWidth), true);
            assert.equal(await row.locator('time').isVisible(), true);
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
          if (process.env.WORKSTATION_VISUAL_OUTPUT && (width === 900 || width === 1440)) {
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
    if (process.env.WORKSTATION_VISUAL_OUTPUT) await page.screenshot({ path: path.join(screenshots, 'native-titlebar-900-new.png') });
    await page.goto(origin + '/edit/research/source.md');
    const draft = '尚未保存的主题切换验证';
    await page.locator('[name="body"]').fill(draft);
    const editorUrl = page.url();
    const opened = app.waitForEvent('window');
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('show-settings').click());
    const settingsPage = await opened;
    await settingsPage.emulateMedia({ colorScheme: null });
    await settingsPage.waitForSelector('body[data-settings-state="clean"]');
    for (const theme of ['dark', 'light', 'system']) {
      await settingsPage.locator('.theme-switch label').filter({
        has: settingsPage.locator('input[value="' + theme + '"]')
      }).click();
      await settingsPage.locator('#save').click();
      await settingsPage.waitForFunction(() => document.querySelector('#message').textContent === '设置已保存。');
      assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), theme);
      const dark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
      await settingsPage.waitForFunction(dark =>
        matchMedia('(prefers-color-scheme: dark)').matches === dark &&
        getComputedStyle(document.body).backgroundColor === (dark ? 'rgb(12, 14, 17)' : 'rgb(248, 249, 250)'), dark);
      assert.equal((await settingsPage.evaluate(() => window.workstationSettings.get())).settings.theme, theme);
      if (process.env.WORKSTATION_VISUAL_OUTPUT) await settingsPage.screenshot({ path: path.join(screenshots, 'settings-' + theme + '.png'), fullPage: true });
      assert.equal(page.url(), editorUrl);
      assert.equal(await page.locator('[name="body"]').inputValue(), draft);
    }
    const recoveryOpened = app.waitForEvent('window');
    await settingsPage.locator('#open-recovery').click();
    const recoveryPage = await recoveryOpened;
    await recoveryPage.waitForLoadState('domcontentloaded');
    for (const scheme of ['light', 'dark']) {
      await recoveryPage.emulateMedia({ colorScheme: scheme });
      if (process.env.WORKSTATION_VISUAL_OUTPUT) await recoveryPage.screenshot({ path: path.join(screenshots, 'recovery-' + scheme + '.png'), fullPage: true });
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

test('正文目录切换、键盘导航、章节跳转与滚动高亮在真实窗口可用', { timeout: 60000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-note-outline-'));
  const vault = path.join(root, 'vault'), userData = path.join(root, 'user');
  const output = process.env.WORKSTATION_VISUAL_OUTPUT || path.join(root, 'screenshots');
  let app, page, passed = false;
  try {
    await fs.mkdir(path.join(vault, 'notes'), { recursive: true });
    await fs.mkdir(path.join(userData, 'workstation-data'), { recursive: true });
    await fs.mkdir(output, { recursive: true });
    const paragraph = '区分相关与因果，需要明确研究问题、识别混杂因素，并通过对照实验检验解释。';
    const sections = ['## 研究问题', '### 变量与假设', '#### 混杂因素', '##### 检查方法', '###### 细节记录', '## 对照实验', '### 数据与评价指标', '### 结果分析', '## 对照实验'];
    const longTitle = '非常长的章节标题用于验证多层目录自动换行以及侧栏中的滚动和选中标记';
    const body = ['# 从相关性走向因果解释', '', ...sections.flatMap(heading => [heading, '', ...Array(8).fill(paragraph + '\n')]), '## ' + longTitle, '', ...Array(18).fill(paragraph + '\n')].join('\n');
    await fs.writeFile(path.join(vault, 'notes', 'outline.md'), body);
    await fs.writeFile(path.join(vault, 'notes', 'source.md'), '# 关联研究\n\n[[outline]]\n');
    await fs.writeFile(path.join(userData, 'workstation-data', 'settings.json'), JSON.stringify({ schemaVersion: 1, vaultDir: vault, device: 'outline-ui', syncEnabled: false }));
    await fs.writeFile(path.join(userData, 'workstation-data', 'guide.json'), JSON.stringify({ version: 2, status: 'completed', step: 6 }));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch(process.env.WORKSTATION_EXECUTABLE
      ? { executablePath: process.env.WORKSTATION_EXECUTABLE, args: ['--workstation-smoke-test', '--workstation-user-data=' + userData], env }
      : { args: [path.resolve(__dirname, '..'), '--workstation-user-data=' + userData], env });
    page = await app.firstWindow();
    await page.waitForSelector('.workspace-sidebar');
    await waitForApi(page, '/api/index-status', status => status.phase === 'ready');
    const origin = new URL(page.url()).origin;
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      for (const width of [900, 1100, 1440, 1920]) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http')).setContentSize(width, 800), width);
        await page.goto(origin + '/note/outline.md');
        await page.evaluate(() => document.fonts.ready);
        const toc = page.getByRole('tab', { name: '目录', exact: true });
        const backlinks = page.getByRole('tab', { name: /反向链接/ });
        assert.equal(await toc.getAttribute('aria-selected'), 'true');
        assert.equal(await page.locator('.note-outline-link').count(), 10);
        assert.equal(await page.locator('.note-outline ol ol ol ol ol').count(), 1);
        const geometry = await page.evaluate(() => {
          const sidebar = document.querySelector('.note-links').getBoundingClientRect();
          const note = document.querySelector('.note').getBoundingClientRect();
          return { sideLeft: sidebar.left, noteRight: note.right, top: sidebar.top, right: document.documentElement.clientWidth - sidebar.right, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        });
        assert.ok(geometry.sideLeft > geometry.noteRight && Math.abs(geometry.right - 28) <= 1 && Math.abs(geometry.top - 32) <= 1 && geometry.overflow <= 1);
        const indents = await page.locator('.note-outline-link').evaluateAll(links => links.slice(0, 5).map(link => link.getBoundingClientRect().left));
        assert.ok(indents.every((left, i) => i === 0 || left > indents[i - 1]), '各级目录逐层缩进');
        await page.waitForFunction(() => document.querySelector('.note-outline-link[aria-current="location"]'));
        if (process.env.WORKSTATION_VISUAL_OUTPUT) await page.screenshot({ path: path.join(output, colorScheme + '-' + width + '-outline.png') });
        await backlinks.click();
        assert.equal(await page.locator('#note-panel-outline').isVisible(), false);
        assert.equal(await page.getByRole('link', { name: '关联研究', exact: true }).isVisible(), true);
        if (process.env.WORKSTATION_VISUAL_OUTPUT) await page.screenshot({ path: path.join(output, colorScheme + '-' + width + '-backlinks.png') });
        await page.keyboard.press('ArrowLeft');
        assert.equal(await toc.evaluate(element => element === document.activeElement), true);
        assert.equal(await toc.getAttribute('aria-selected'), 'true');
        await page.keyboard.press('End');
        assert.equal(await backlinks.getAttribute('aria-selected'), 'true');
        await page.keyboard.press('Home');
        const target = page.locator('.note-outline-link').last();
        const targetId = await target.getAttribute('data-outline-target');
        await target.click();
        await page.waitForFunction(id => location.hash === '#' + id && document.querySelector('.note-outline-link[aria-current="location"]')?.dataset.outlineTarget === id, targetId);
        await page.waitForFunction(id => Math.abs(document.getElementById(id).getBoundingClientRect().top - 24) <= 1, targetId);
        const sticky = await page.locator('.note-links').boundingBox();
        assert.ok(Math.abs(sticky.y - 32) <= 1, '长文阅读时右侧切换按钮保持可见');
        const secondId = await page.locator('.note-outline-link').nth(1).getAttribute('data-outline-target');
        // Mac点击章节后可能仍把焦点留在标签上；未消费的PageUp也要释放章节锁。
        await toc.focus();
        await page.evaluate(() => {
          window.outlinePageUpEnded = false;
          window.addEventListener('scrollend', () => { window.outlinePageUpEnded = true; }, { once: true });
        });
        await page.keyboard.press('PageUp');
        await page.waitForFunction(() => window.outlinePageUpEnded, null, { timeout: 5000 });
        // 等键盘滚动结束后再做独立的程序滚动，避免两个滚动动作互相覆盖。
        await page.evaluate(id => document.getElementById(id).scrollIntoView({ block: 'start', behavior: 'instant' }), secondId);
        await page.waitForFunction(id => Math.abs(document.getElementById(id).getBoundingClientRect().top - 24) <= 1
          && document.querySelector('.note-outline-link[aria-current="location"]')?.dataset.outlineTarget === id, secondId);
      }
    }
    // 矮窗口中的长目录独立滚动，不撑长页面或遮住切换控件。
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http')).setContentSize(900, 620));
    await fs.writeFile(path.join(vault, 'notes', 'long-outline.md'), body + '\n' + Array.from({ length: 35 }, (_, i) => '## 附录 ' + (i + 1)).join('\n\n'));
    await page.goto(origin + '/note/long-outline.md');
    const panel = await page.locator('#note-panel-outline').evaluate(element => ({ bottom: element.getBoundingClientRect().bottom, height: innerHeight, scroll: element.scrollHeight, client: element.clientHeight }));
    assert.ok(panel.bottom <= panel.height - 28 && panel.scroll > panel.client, JSON.stringify(panel));
    if (process.env.WORKSTATION_VISUAL_OUTPUT) await page.screenshot({ path: path.join(output, 'dark-900-long-outline.png') });
    await page.locator('.note-outline-link').last().click();
    await page.getByRole('tab', { name: /反向链接/ }).click();
    await page.locator('#note-panel-outline').evaluate(element => { element.scrollTop = 0; });
    await page.getByRole('tab', { name: '目录', exact: true }).click();
    assert.equal(await page.locator('.note-outline-link[aria-current="location"]').evaluate(link => {
      const box = link.getBoundingClientRect(), panel = link.closest('[role="tabpanel"]').getBoundingClientRect();
      return box.top >= panel.top && box.bottom <= panel.bottom + 1;
    }), true, '切回目录时当前章节完整可见');
    // 默认平滑滚动下，短尾部两个章节同时可见时保留明确点击的章节。
    await fs.writeFile(path.join(vault, 'notes', 'short-tail.md'), '# 末尾章节测试\n\n## 开篇\n\n' + Array(24).fill('这是一段用于让正文产生纵向滚动的内容。').join('\n\n') + '\n\n## 中间章节\n\n一行内容\n\n## 最后一节\n\n结尾。\n');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http')).setContentSize(1100, 800));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(origin + '/note/short-tail.md');
    await page.evaluate(() => document.fonts.ready);
    const middleId = await page.locator('.note-outline-link').nth(1).getAttribute('data-outline-target');
    await page.evaluate(id => {
      window.outlineScrollEnded = false;
      window.addEventListener('scrollend', () => {
        if (location.hash === '#' + id && scrollY > 0) window.outlineScrollEnded = true;
      });
    }, middleId);
    await page.locator('.note-outline-link').nth(1).click();
    await page.waitForFunction(() => window.outlineScrollEnded, null, { timeout: 5000 });
    assert.equal(await page.locator('.note-outline-link[aria-current="location"]').getAttribute('data-outline-target'), middleId, '平滑跳转后高亮与明确点击的章节一致');
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.note-outline-link[aria-current="location"]').getAttribute('data-outline-target'), middleId, '重新计算布局不会覆盖明确选择');
    await page.mouse.move(200, 300);
    await page.mouse.wheel(0, -1000);
    await page.waitForFunction(id => document.querySelector('.note-outline-link[aria-current="location"]')?.dataset.outlineTarget !== id, middleId);
    await page.evaluate(() => { window.outlineScrollEnded = false; });
    await page.locator('.note-outline-link').nth(1).click();
    await page.waitForFunction(() => window.outlineScrollEnded, null, { timeout: 5000 });
    const sidebarBox = await page.locator('.note-links').boundingBox();
    await page.mouse.move(sidebarBox.x + 20, sidebarBox.y + 80);
    await page.mouse.wheel(0, -1000);
    await page.waitForFunction(id => scrollY < 10 && document.querySelector('.note-outline-link[aria-current="location"]')?.dataset.outlineTarget !== id, middleId);
    await page.goto(origin + '/note/short-tail.md#' + encodeURIComponent('H-中间章节'));
    await page.waitForFunction(id => document.querySelector('.note-outline-link[aria-current="location"]')?.dataset.outlineTarget === id, middleId);
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.note-outline-link[aria-current="location"]').getAttribute('data-outline-target'), middleId, '中文 H 标题别名也保持正确高亮');
    passed = true;
  } finally {
    if (!passed) {
      await page?.screenshot({ path: path.join(root, 'failure.png'), timeout: 5000 }).catch(() => {});
      console.error('[note-outline] artifacts preserved at ' + root);
    }
    if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
    if (passed && !process.env.WORKSTATION_VISUAL_OUTPUT) await fs.rm(root, { recursive: true, force: true });
  }
});

test('密集月历的末周事项可滚动及键盘到达，星期列保持对齐', { timeout: 45000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-dense-calendar-'));
  const vault = path.join(root, 'vault'), userData = path.join(root, 'user');
  let app, page, passed = false;
  try {
    await fs.mkdir(path.join(vault, 'notes'), { recursive: true });
    await fs.mkdir(path.join(userData, 'workstation-data'), { recursive: true });
    const body = ['# 密集月份'];
    for (let day = 1; day <= 30; day++) for (let task = 1; task <= 4; task++) body.push('- [ ] 日期' + day + '待办' + task + ' @2026-11-' + String(day).padStart(2, '0'));
    await fs.writeFile(path.join(vault, 'notes', 'tasks.md'), body.join('\n'));
    await fs.writeFile(path.join(userData, 'workstation-data', 'settings.json'), JSON.stringify({ schemaVersion: 1, vaultDir: vault, device: 'dense-calendar', syncEnabled: false }));
    await fs.writeFile(path.join(userData, 'workstation-data', 'guide.json'), JSON.stringify({ version: 2, status: 'completed', step: 6 }));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch(process.env.WORKSTATION_EXECUTABLE
      ? { executablePath: process.env.WORKSTATION_EXECUTABLE, args: ['--workstation-smoke-test', '--workstation-user-data=' + userData], env }
      : { args: [path.resolve(__dirname, '..'), '--workstation-user-data=' + userData], env });
    page = await app.firstWindow();
    await page.waitForSelector('.workspace-sidebar');
    await waitForApi(page, '/api/index-status', status => status.phase === 'ready');
    const origin = new URL(page.url()).origin;
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      for (const [width, height] of [[1100, 800], [1100, 620], [1440, 900], [900, 620]]) {
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http')).setContentSize(size.width, size.height), { width, height });
        await page.goto(origin + '/plan?view=calendar&month=2026-11&date=2026-11-30');
        await page.evaluate(() => document.fonts.ready);
        if (width > 1040) {
          await page.locator('.calgrid').hover();
          await page.mouse.wheel(0, 2000);
          await page.waitForFunction(() => {
            const pill = document.querySelector('[data-calendar-day="2026-11-30"] .is-more');
            const r = pill.getBoundingClientRect(), grid = pill.closest('.calgrid').getBoundingClientRect();
            return r.top >= grid.top && r.bottom <= Math.min(grid.bottom, innerHeight) && pill === document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          }, null, { timeout: 2500 });
        }
        await page.locator('.calday').last().focus();
        const geometry = await page.evaluate(() => {
          const active = document.activeElement, cell = active.getBoundingClientRect(), grid = active.closest('.calgrid').getBoundingClientRect();
          const header = document.querySelector('.calgrid-head').getBoundingClientRect();
          const columns = [...document.querySelectorAll('.calgrid-head span')].map(element => element.getBoundingClientRect());
          const days = [...document.querySelectorAll('.calday')].slice(-7).map(element => element.getBoundingClientRect());
          return { reachable: cell.bottom <= Math.min(grid.bottom, innerHeight) + 1 && cell.top >= Math.max(grid.top, 0) && active.contains(document.elementFromPoint(cell.left + cell.width / 2, cell.top + cell.height / 2)), headerTop: header.top, gridTop: grid.top, aligned: columns.every((column, i) => Math.abs(column.left - days[i].left) <= 1 && Math.abs(column.width - days[i].width) <= 1), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        });
        assert.ok(geometry.reachable && geometry.aligned && geometry.overflow <= 1, colorScheme + ' ' + width + '×' + height + ': ' + JSON.stringify(geometry));
        if (width > 1040) assert.ok(Math.abs(geometry.headerTop - geometry.gridTop - 1) <= 1, '滚动后星期表头仍固定可见');
        await page.locator('.calday').nth(7).focus();
        await page.keyboard.press('Shift+Tab');
        const firstWeek = await page.locator('.calday-num').nth(6).evaluate(marker => {
          const r = marker.getBoundingClientRect();
          const header = document.querySelector('.calgrid-head').getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { visible: hit === marker || marker.contains(hit), top: r.top, headerBottom: header.bottom };
        });
        assert.ok(firstWeek.visible && firstWeek.top >= Math.max(firstWeek.headerBottom, 0), '键盘回到首周时日期圆标不被表头覆盖：' + JSON.stringify(firstWeek));
      }
    }
    passed = true;
  } finally {
    if (!passed) { await page?.screenshot({ path: path.join(root, 'failure.png'), timeout: 5000 }).catch(() => {}); console.error('[dense-calendar] artifacts preserved at ' + root); }
    if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
    if (passed) await fs.rm(root, { recursive: true, force: true });
  }
});
