const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { _electron: electron } = require('playwright-core');
const { saveVersion } = require('../src/vault/history');

test('长卡组、历史路径、独立窗口底栏和错误信息的真实布局', { timeout: 90000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-ui-details-'));
  const vault = path.join(root, 'vault');
  const userData = path.join(root, 'user');
  const token = 'LongModelIdentifier'.repeat(8);
  const historyPath = 'history/' + 'LongPathSegment'.repeat(8) + '.md';
  let app, page, failed = false;
  async function check(name, fn) {
    await t.test(name, async () => {
      try { await fn(); }
      catch (error) {
        failed = true;
        await page?.screenshot({ path: path.join(root, name + '.png'), animations: 'disabled', timeout: 5000 }).catch(() => {});
        throw error;
      }
    });
  }
  async function resize(target, width) {
    await app.evaluate(({ BrowserWindow }, options) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === options.url).setContentSize(options.width, 620), { url: target.url(), width });
    await target.evaluate(() => document.fonts.ready);
  }
  async function assertPage(target) {
    const size = await target.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(size.scroll <= size.width + 1, '页面不能产生横向滚动：' + JSON.stringify(size));
  }
  async function assertButtons(target, selector) {
    const controls = await target.locator(selector).evaluateAll(elements => elements.filter(e => e.getClientRects().length).map(element => {
      const box = element.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(element);
      return { text: element.textContent.trim(), inside: [...range.getClientRects()].every(r => r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1) };
    }));
    assert.ok(controls.length > 0);
    assert.ok(controls.every(control => control.inside), '按钮文字完整可见：' + JSON.stringify(controls));
  }
  async function assertFooter(target, selector, lastControl) {
    const geometry = await target.evaluate(selector => {
      const main = document.querySelector('main'), footer = document.querySelector(selector);
      const bounds = main.getBoundingClientRect(), style = getComputedStyle(main);
      const visibleButtons = [...footer.querySelectorAll('button')].filter(e => e.getClientRects().length);
      return {
        left: bounds.left + parseFloat(style.paddingLeft), right: bounds.right - parseFloat(style.paddingRight),
        message: footer.querySelector('p').getBoundingClientRect().left,
        action: visibleButtons.at(-1).getBoundingClientRect().right
      };
    }, selector);
    assert.ok(Math.abs(geometry.left - geometry.message) <= 1 && Math.abs(geometry.right - geometry.action) <= 1, '底栏与正文两侧对齐：' + JSON.stringify(geometry));
    await target.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
    const reachable = await target.locator(lastControl).evaluate((element, selector) => {
      const r = element.getBoundingClientRect(), footer = document.querySelector(selector).getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return r.top >= 0 && r.bottom <= footer.top && (hit === element || element.contains(hit));
    }, selector);
    assert.equal(reachable, true, '最后一个控件可以滚动到底栏上方，且未被遮挡');
    await assertButtons(target, selector + ' button');
    await assertPage(target);
  }
  try {
    await fs.mkdir(path.join(vault, 'notes', 'history'), { recursive: true });
    await fs.mkdir(path.join(vault, 'cards'), { recursive: true });
    await fs.mkdir(path.join(userData, 'workstation-data'), { recursive: true });
    await fs.writeFile(path.join(vault, 'notes', historyPath), '# ' + token + '\n\n正文\n');
    const version = await saveVersion(path.join(vault, 'notes'), historyPath, '# ' + token + '\n\n旧版本\n', 'save');
    await fs.writeFile(path.join(vault, 'cards', 'long.md'), '---\ndeck: ' + token + '\n---\n\n## Long card\n\nAnswer\n');
    await fs.writeFile(path.join(vault, 'cards', 'short.md'), '---\ndeck: 短卡组\n---\n\n## 短题目\n\n答案\n');
    await fs.writeFile(path.join(userData, 'workstation-data', 'settings.json'), JSON.stringify({ schemaVersion: 1, vaultDir: vault, device: 'ui-details', syncEnabled: false }));
    await fs.writeFile(path.join(userData, 'workstation-data', 'guide.json'), JSON.stringify({ version: 2, status: 'completed', step: 6 }));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch(process.env.WORKSTATION_EXECUTABLE
      ? { executablePath: process.env.WORKSTATION_EXECUTABLE, args: ['--workstation-smoke-test', '--workstation-user-data=' + userData], env }
      : { args: [path.resolve(__dirname, '..'), '--workstation-user-data=' + userData], env });
    page = await app.firstWindow();
    page.setDefaultTimeout(6000);
    await page.waitForSelector('.workspace-sidebar');
    await page.waitForFunction(async () => (await fetch('/api/index-status').then(r => r.json())).phase === 'ready');
    const origin = new URL(page.url()).origin;
    await check('长卡组名称不撑出标题和筛选行', async () => {
      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        for (const width of [900, 1100, 1440]) {
          await resize(page, width);
          for (const route of ['/cards', '/cards?deck=' + encodeURIComponent(token)]) {
            await page.goto(origin + route);
            await page.evaluate(() => document.fonts.ready);
            await assertPage(page);
            await assertButtons(page, '.page-head .button');
            const actionsAligned = await page.locator('.cards-page .page-head .actions').evaluate(element => Math.abs(element.getBoundingClientRect().right - element.parentElement.getBoundingClientRect().right) <= 1);
            assert.equal(actionsAligned, true, '标题换行后操作组仍靠右对齐');
            const chipsInside = await page.locator('.card-deck-filter .chip').evaluateAll(elements => elements.every(element => {
              const box = element.getBoundingClientRect(), parent = element.parentElement.getBoundingClientRect();
              return box.left >= parent.left - 1 && box.right <= parent.right + 1;
            }));
            assert.equal(chipsInside, true);
          }
        }
      }
    });
    await check('历史筛选长路径不挤走预览恢复按钮', async () => {
      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        for (const width of [900, 1100, 1440]) {
          await resize(page, width);
          await page.goto(origin + '/history?id=' + encodeURIComponent(version.id) + '&path=' + encodeURIComponent(historyPath));
          await page.evaluate(() => document.fonts.ready);
          await assertPage(page);
          await assertButtons(page, '.history-preview-head .button');
          const contained = await page.locator('.history-preview-head .button').evaluate(element => {
            const box = element.getBoundingClientRect(), parent = element.closest('.history-preview-head').getBoundingClientRect();
            return box.left >= parent.left && box.right <= parent.right + 1;
          });
          assert.equal(contained, true);
          await page.locator('.history-preview-head .button').click();
          await page.waitForURL('**/recover/**');
          assert.match(await page.locator('[name="body"]').inputValue(), /旧版本/);
        }
      }
    });
    const opened = app.waitForEvent('window');
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('show-settings').click());
    const settings = await opened;
    await settings.waitForSelector('body[data-settings-state="clean"]');
    page = settings;
    await check('设置底栏在最小和加宽窗口中与正文对齐', async () => {
      for (const colorScheme of ['light', 'dark']) {
        await settings.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        for (const width of [760, 1040, 1440]) {
          await resize(settings, width);
          await assertFooter(settings, '.save-bar', '#open-config');
          const sameHeight = await settings.locator('.path-control').evaluate(element => {
            const input = element.querySelector('input').getBoundingClientRect(), button = element.querySelector('button').getBoundingClientRect();
            return Math.abs(input.height - button.height) <= 1 && Math.abs(input.top - button.top) <= 1;
          });
          assert.equal(sameHeight, true, '路径输入框与选择按钮同高且对齐');
        }
      }
    });
    await check('设置同步错误中的连续英文在面板内换行', async () => {
      const message = 'LongUnbrokenSyncError'.repeat(12);
      await app.evaluate(({ BrowserWindow }, error) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/settings/')).webContents.send('sync-status:changed', { phase: 'error', lastResult: { error } }), message);
      await settings.waitForFunction(() => document.querySelector('#sync-status').dataset.phase === 'error');
      for (const colorScheme of ['light', 'dark']) {
        await settings.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        for (const width of [760, 1040, 1440]) {
          await resize(settings, width);
          await settings.locator('#sync-status').scrollIntoViewIfNeeded();
          await assertPage(settings);
          const contained = await settings.locator('#sync-status-detail').evaluate(element => {
            const bounds = element.closest('#sync-status').getBoundingClientRect();
            const range = document.createRange(); range.selectNodeContents(element);
            return [...range.getClientRects()].every(r => r.left >= bounds.left && r.right <= bounds.right + 1);
          });
          assert.equal(contained, true);
          assert.equal(await settings.locator('#sync-status-detail').textContent(), message, '错误信息不丢失或截断');
        }
      }
    });
    const recoveryOpened = app.waitForEvent('window');
    await settings.locator('#open-recovery').click();
    const recovery = await recoveryOpened;
    await recovery.waitForSelector('#source-panel', { state: 'visible' });
    page = recovery;
    await check('恢复底栏与正文对齐且不遮挡最后的目录输入框', async () => {
      for (const colorScheme of ['light', 'dark']) {
        await recovery.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        for (const width of [900, 1100, 1440]) {
          await resize(recovery, width);
          await assertFooter(recovery, 'footer.actions', '#directory-name');
        }
      }
    });
    await check('恢复残留提示较长时操作按钮不被挤成多行', async () => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/recovery/')).webContents.send('recovery:state-changed', { mode: 'restore', phase: 'residue', residue: { owned: false }, canOpenCurrentVault: true }));
      await recovery.waitForSelector('#dismiss-residue:not([hidden])');
      for (const colorScheme of ['light', 'dark']) {
        await recovery.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        for (const width of [900, 1100, 1440]) {
          await resize(recovery, width);
          const sameHeight = await recovery.locator('footer.actions button:not([hidden])').evaluateAll(elements => elements.every(element => Math.abs(element.getBoundingClientRect().height - parseFloat(getComputedStyle(element).getPropertyValue('--control'))) <= 1));
          assert.equal(sameHeight, true, '底栏按钮保持标准高度，文字不换行');
          await assertButtons(recovery, 'footer.actions button');
          await assertPage(recovery);
        }
      }
    });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (failed || t.signal.aborted) console.error('[ui-details] artifacts preserved at ' + root);
    if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
    if (!failed && !t.signal.aborted) await fs.rm(root, { recursive: true, force: true });
  }
});
