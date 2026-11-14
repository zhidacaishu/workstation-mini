const test = require('node:test');
const { waitForApi } = require('./desktop-test-utils');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { _electron: electron } = require('playwright-core');

test('公式离线显示、窄屏、源码建卡、保存与复习', { timeout: 60000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-math-desktop-'));
  const vault = path.join(root, 'vault');
  const userData = path.join(root, 'user');
  let app, page, passed = false;
  const startupLog = [];
  const recordStartup = value => { startupLog.push(String(value)); if (startupLog.length > 40) startupLog.shift(); };
  try {
    await fs.mkdir(path.join(vault, 'notes'), { recursive: true });
    await fs.mkdir(path.join(vault, 'cards'), { recursive: true });
    await fs.mkdir(path.join(userData, 'workstation-data'), { recursive: true });
    const math = '$\\frac{a}{b}$';
    const block = '$$\n\\sum_{i=1}^{n} x_i = ' + Array(45).fill('x_i').join(' + ') + '\n$$';
    await fs.writeFile(path.join(vault, 'notes', 'math.md'), '# 公式测试\n\n中文 ' + math + ' 结束\n\n' + block + '\n\n$\\unknown{x}$');
    await fs.writeFile(path.join(vault, 'cards', 'math.md'), '## 公式挖空\n答案 {{ ' + math + ' }}');
    await fs.writeFile(path.join(userData, 'workstation-data', 'guide.json'), JSON.stringify({ step: 7, status: 'completed' }));
    await fs.writeFile(path.join(userData, 'workstation-data', 'settings.json'), JSON.stringify({ schemaVersion: 1, vaultDir: vault, device: 'math-smoke', syncEnabled: false }));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch(process.env.WORKSTATION_EXECUTABLE
      ? { executablePath: process.env.WORKSTATION_EXECUTABLE, args: ['--workstation-smoke-test', '--workstation-user-data=' + userData], env }
      : { args: [path.resolve(__dirname, '..'), '--workstation-user-data=' + userData], env });
    app.process().stdout?.on('data', recordStartup);
    app.process().stderr?.on('data', recordStartup);
    try {
      page = await app.firstWindow();
    } catch (error) {
      const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
        title: window.getTitle(), url: window.webContents.getURL(), visible: window.isVisible(), loading: window.webContents.isLoading()
      }))).catch(failure => ({ diagnosticError: failure.message }));
      console.error('[math-startup] ' + JSON.stringify({ windows, output: startupLog }));
      throw error;
    }
    const errors = [], external = [], failed = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('requestfailed', r => failed.push(r.url()));
    await page.waitForSelector('.workspace-sidebar');
    await waitForApi(page, '/api/index-status', status => status.phase === 'ready');
    const origin = new URL(page.url()).origin;
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    await page.goto(origin + '/note/math.md');
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('.prose .katex').count(), 2);
    assert.equal(await page.locator('.math-error').count(), 1);
    assert.equal(await page.evaluate(() => document.fonts.check('16px KaTeX_Main')), true);
    for (const theme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: 900, height: 720 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.locator('.math-display').evaluate(e => e.scrollWidth > e.clientWidth && getComputedStyle(e).overflowX === 'auto'), true);
    }
    await page.locator('.prose p').filter({ hasText: '中文' }).evaluate(p => {
      const range = document.createRange(); range.selectNodeContents(p);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await page.locator('.selection-card button').click();
    assert.equal(await page.locator('.selection-form [name=front]').inputValue(), '中文 ' + math + ' 结束');
    await page.locator('.selection-form [data-cancel]').click();
    // Even one selected rendered glyph restores the complete formula.
    await page.locator('.math-source').first().evaluate(el => {
      const node = el.querySelector('.katex-html .mathnormal').firstChild;
      const range = document.createRange(); range.selectNodeContents(node);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await page.locator('.selection-card button').click();
    assert.equal(await page.locator('.selection-form [name=front]').inputValue(), math);
    await page.locator('.selection-form [data-save]').click();
    await page.waitForSelector('.selection-form', { state: 'detached' });
    assert.match(await fs.readFile(path.join(vault, 'cards', 'inbox.md'), 'utf8'), /## \$\\frac\{a\}\{b\}\$/);
    await page.locator('.math-display').evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await page.locator('.selection-card button').click();
    assert.equal(await page.locator('.selection-form [name=back]').inputValue(), block);
    await page.locator('.selection-form [data-cancel]').click();
    if (process.env.WORKSTATION_VISUAL_OUTPUT) {
      await fs.mkdir(process.env.WORKSTATION_VISUAL_OUTPUT, { recursive: true });
      await page.screenshot({ path: path.join(process.env.WORKSTATION_VISUAL_OUTPUT, 'katex-preview.png'), fullPage: true });
    }
    await page.goto(origin + '/review?deck=math');
    assert.equal(await page.locator('#review-front .katex').count(), 0);
    await page.locator('#review-reveal').click();
    // 挖空卡的答案在题面原位亮出来，不在卡片底部再重复一遍。
    assert.equal(await page.locator('#review-front .cloze-answer .katex').count(), 1);
    assert.equal(await page.locator('#review-front .cloze-answer [data-math-source]').getAttribute('data-math-source'), math);
    assert.equal(await page.locator('#review-back').isVisible(), false);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.deepEqual(failed, []);
    passed = true;
  } finally {
    if (!passed) { await page?.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }).catch(() => {}); console.error(root); }
    if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
    if (passed) await fs.rm(root, { recursive: true, force: true });
  }
});
