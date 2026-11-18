const test = require('node:test');
const { waitForApi } = require('./desktop-test-utils');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { _electron: electron } = require('playwright-core');
const { saveVersion } = require('../src/vault/history');

// 包含启动、索引及多页面/尺寸/主题矩阵，慢速 Windows runner 上整组可能超过 90 秒。
// 单项操作仍受 Playwright 的 6 秒时限约束，每个子用例也有独立上限。
test('长卡组、历史路径、独立窗口底栏和错误信息的真实布局', { timeout: 180000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-ui-details-'));
  const vault = path.join(root, 'vault');
  const userData = path.join(root, 'user');
  const token = 'LongModelIdentifier'.repeat(8);
  const historyPath = 'history/' + 'LongPathSegment'.repeat(8) + '.md';
  const now = new Date();
  const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  let app, page, failed = false;
  async function check(name, fn) {
    await t.test(name, { timeout: 60000 }, async () => {
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
    await fs.mkdir(path.join(vault, 'notes', 'experiments'), { recursive: true });
    await fs.mkdir(path.join(userData, 'workstation-data'), { recursive: true });
    await fs.writeFile(path.join(vault, 'notes', historyPath), '# ' + token + '\n\n正文\n');
    const version = await saveVersion(path.join(vault, 'notes'), historyPath, '# ' + token + '\n\n旧版本\n', 'save');
    await fs.writeFile(path.join(vault, 'cards', 'long.md'), '---\ndeck: ' + token + '\n---\n\n## Long card\n\nAnswer\n');
    await fs.writeFile(path.join(vault, 'cards', 'short.md'), '---\ndeck: 短卡组\n---\n\n## 短题目\n\n答案\n');
    await fs.writeFile(path.join(vault, 'notes', 'today.md'), '# 当天任务来源\n\n- [ ] 整理实验记录 @' + today + '\n- [ ] 核对评价指标 @' + today + '\n- [ ] 检查未完成的旧任务 @2000-01-01\n');
    await fs.writeFile(path.join(vault, 'notes', 'experiments', 'project.md'), [
      '---', 'title: 检索增强生成的可解释性评估', 'status: running',
      'dataset: HotpotQA · 500 samples', 'deadline: ' + today,
      'next: 完成对照实验，比较检索证据与推理路径', '---', '', '研究记录。'
    ].join('\n'));
    await fs.writeFile(path.join(vault, 'notes', 'experiments', 'done.md'), [
      '---', 'title: 小样本可行性验证', 'status: done',
      'dataset: 50 个验证样本', 'result: 引用准确率不等于证据依赖性', '---', '', '验证记录。'
    ].join('\n'));
    await fs.writeFile(path.join(userData, 'workstation-data', 'settings.json'), JSON.stringify({ schemaVersion: 1, vaultDir: vault, device: 'ui-details', syncEnabled: false }));
    await fs.writeFile(path.join(userData, 'workstation-data', 'guide.json'), JSON.stringify({ version: 2, status: 'completed', step: 6 }));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch(process.env.WORKSTATION_EXECUTABLE
      ? { executablePath: process.env.WORKSTATION_EXECUTABLE, args: ['--workstation-smoke-test', '--workstation-user-data=' + userData], env }
      : { args: [path.resolve(__dirname, '..'), '--workstation-user-data=' + userData], env });
    page = await app.firstWindow();
    page.setDefaultTimeout(6000);
    await page.waitForSelector('.workspace-sidebar');
    await waitForApi(page, '/api/index-status', status => status.phase === 'ready');
    const origin = new URL(page.url()).origin;
    await page.goto(origin + '/cards');
    const cardEditPath = await page.locator('.card-row-front').first().getAttribute('href');
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
    await check('首页恢复研究、最近笔记与今日事项的原有布局', async () => {
      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        for (const width of [900, 1100, 1440]) {
          await resize(page, width);
          await page.goto(origin + '/');
          await page.evaluate(() => document.fonts.ready);
          await assertPage(page);
          const layout = await page.evaluate(() => {
            const rect = selector => document.querySelector(selector).getBoundingClientRect();
            const tasks = rect('.desk-side'), research = rect('.desk-research'), recent = rect('.desk-recent');
            return { tasksTop: tasks.top, researchTop: research.top, recentTop: recent.top, tasksLeft: tasks.left, researchRight: research.right };
          });
          if (width === 900) {
            assert.ok(layout.researchTop < layout.recentTop && layout.recentTop < layout.tasksTop);
          } else {
            assert.ok(Math.abs(layout.tasksTop - layout.researchTop) <= 1);
            assert.ok(layout.tasksLeft >= layout.researchRight);
          }
          assert.equal(await page.locator('.onboarding-steps li').count(), 4);
          assert.equal(await page.locator('.onboarding-steps').isVisible(), true);
          assert.equal(await page.locator('.onboarding-next-text').isVisible(), true);
        }
      }
    });
    await check('主页面铺满工作区，内容及分栏随窗口展开', async () => {
      const routes = [
        ['today', '/', '.desk-header', '.desk-layout'],
        ['library', '/search', '.page-head', '.library'],
        ['board', '/board/experiment', '.page-head', '.board'],
        ['note', '/note/experiments/project.md', '.note-title-row', '.note-layout'],
        ['editor', '/edit/experiments/project.md', '.editor-head', '.editform'],
        ['new', '/new', '.editor-head', '.editform'],
        ['history', '/history', '.page-head', '.history-layout'],
        ['history-preview', '/history?id=' + encodeURIComponent(version.id) + '&path=' + encodeURIComponent(historyPath), '.page-head', '.history-layout'],
        ['calendar', '/plan?view=calendar', '.plan-header', '.plan-calendar-layout'],
        ['plan-list', '/plan?view=list', '.plan-header', '.plan-list'],
        ['decks', '/decks', '.page-head', '.narrow'],
        ['cards', '/cards', '.page-head', '.cards-page'],
        ['card-edit', cardEditPath, '.page-head', '.card-edit'],
        ['guide', '/guide', '.page-head', '.guide-page'],
        ['health', '/health', '.page-head', '.health-grid'],
        ['review', '/review', null, '.reviewer']
      ];
      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        for (const width of [900, 1440, 1920, 2560]) {
          const height = width === 900 ? 800 : 1000;
          await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http')).setContentSize(size.width, size.height), { width, height });
          for (const [name, route, headerSelector, contentSelector] of routes) {
            await page.goto(origin + route);
            await page.evaluate(() => document.fonts.ready);
            await assertPage(page);
            const geometry = await page.evaluate(({ headerSelector, contentSelector }) => {
              const rect = selector => document.querySelector(selector).getBoundingClientRect();
              const page = rect('.page'), content = rect(contentSelector), rail = rect('.workspace-sidebar');
              const header = headerSelector && rect(headerSelector);
              const history = document.querySelector('.history-layout');
              const historyRecords = history && rect('.history-records');
              const preview = document.querySelector('.history-preview-panel');
              const card = document.querySelector('.reviewcard');
              const footer = document.querySelector('.editor-footer');
              return {
                pageRight: page.right, viewport: document.documentElement.clientWidth, viewportHeight: innerHeight,
                left: content.left - rail.right, right: page.right - content.right,
                headerLeft: header && header.left - rail.right, headerTop: header && header.top,
                historyFull: historyRecords && !preview ? Math.abs(historyRecords.width - history.getBoundingClientRect().width) <= 1 : null,
                previewBeside: preview && preview.getBoundingClientRect().left >= historyRecords.right,
                footerBottom: footer && footer.getBoundingClientRect().bottom,
                reviewBottom: card && rect('.review-actions').bottom
              };
            }, { headerSelector, contentSelector });
            assert.ok(Math.abs(geometry.pageRight - geometry.viewport) <= 1, route + ': 页面随窗口铺满');
            assert.ok(Math.abs(geometry.left - 28) <= 1 && Math.abs(geometry.right - 28) <= 1, route + ': 内容没有另设固定上限：' + JSON.stringify(geometry));
            if (headerSelector) assert.ok(Math.abs(geometry.headerLeft - 28) <= 1 && Math.abs(geometry.headerTop - 32) <= 1, route + ': 页头基准一致');
            if (name === 'history') assert.equal(geometry.historyFull, true, '未选记录时不预留空预览栏');
            if (name === 'history-preview') assert.equal(Boolean(geometry.previewBeside), width > 1040, '历史预览在宽屏并排、窄屏堆叠');
            if (name === 'editor' || name === 'new') assert.ok(Math.abs(geometry.footerBottom - geometry.viewportHeight + 48) <= 1, '编辑区使用剩余高度');
            if (name === 'review') assert.ok(Math.abs(geometry.reviewBottom - geometry.viewportHeight + 48) <= 1, '复习卡片使用剩余高度');
            if (process.env.WORKSTATION_VISUAL_OUTPUT && width !== 2560) {
              await fs.mkdir(process.env.WORKSTATION_VISUAL_OUTPUT, { recursive: true });
              await page.screenshot({ path: path.join(process.env.WORKSTATION_VISUAL_OUTPUT, colorScheme + '-' + width + '-' + name + '.png') });
            }
          }
        }
      }
    });
    await check('看板按标题、数据集、下一步与截止日分层，状态入口清楚可见', async () => {
      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        for (const width of [900, 1440]) {
          await resize(page, width);
          await page.goto(origin + '/board/experiment');
          await page.evaluate(() => document.fonts.ready);
          const card = page.locator('[data-board-card][data-status="running"]');
          const geometry = await card.evaluate(element => {
            const title = element.querySelector('.board-title'), dataset = element.querySelector('.board-dataset');
            const next = element.querySelector('[data-board-next]'), footer = element.querySelector('.board-card-footer');
            return { titleSize: parseFloat(getComputedStyle(title).fontSize), datasetSize: parseFloat(getComputedStyle(dataset).fontSize), datasetTop: dataset.getBoundingClientRect().top, titleBottom: title.getBoundingClientRect().bottom, nextTop: next.getBoundingClientRect().top, datasetBottom: dataset.getBoundingClientRect().bottom, footerTop: footer.getBoundingClientRect().top, nextBottom: next.getBoundingClientRect().bottom, stateOpacity: Number(getComputedStyle(element.querySelector('.statusform')).opacity) };
          });
          assert.ok(geometry.titleSize > geometry.datasetSize);
          assert.ok(geometry.datasetTop >= geometry.titleBottom && geometry.nextTop >= geometry.datasetBottom && geometry.footerTop >= geometry.nextBottom);
          assert.ok(geometry.stateOpacity > 0, '状态箭头不再完全隐藏');
          await card.locator('select').focus();
          await assertPage(page);
        }
      }
    });
    await check('月历日期为正圆，宽高窗口不留下额外的左侧与底部空白', async () => {
      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        for (const [width, height] of [[900, 620], [1100, 620], [1100, 800], [1440, 900], [1920, 1200]]) {
          await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http')).setContentSize(size.width, size.height), { width, height });
          await page.goto(origin + '/plan?view=calendar&date=' + today);
          await page.evaluate(() => document.fonts.ready);
          await assertPage(page);
          const geometry = await page.evaluate(() => {
            const rect = selector => document.querySelector(selector).getBoundingClientRect();
            const grid = rect('.calgrid'), rail = rect('.workspace-sidebar'), canvas = rect('.page');
            return {
              left: grid.left - rail.right,
              right: document.documentElement.clientWidth - rect('.plan-day-detail').right,
              viewportWidth: innerWidth, viewportHeight: innerHeight,
              pageHeight: canvas.height,
              minPageHeight: parseFloat(getComputedStyle(document.querySelector('.page')).minHeight) || 0,
              bottom: canvas.bottom - grid.bottom,
              markers: [...document.querySelectorAll('.calday-num')].map(element => {
                const r = element.getBoundingClientRect();
                const range = document.createRange(); range.selectNodeContents(element);
                const text = range.getBoundingClientRect();
                return { width: r.width, height: r.height, centered: Math.abs((text.left + text.right) / 2 - (r.left + r.right) / 2) < 1 };
              }),
              badges: [...document.querySelectorAll('.nav-badge')].filter(element => element.textContent.trim().length === 1).map(element => {
                const r = element.getBoundingClientRect(); return Math.abs(r.width - r.height);
              })
            };
          });
          assert.ok(geometry.left >= 24 && geometry.left <= 32, '月历靠近侧栏，保留标准页边距：' + JSON.stringify(geometry));
          assert.ok(geometry.right >= 24 && geometry.right <= 32, '两侧页边距一致：' + JSON.stringify(geometry));
          // 原生窗口可能被 CI 显示器限高；使用实际 viewport，矮窗口保留页面最小高度。
          if (geometry.viewportWidth > 1040) {
            assert.ok(Math.abs(geometry.pageHeight - Math.max(geometry.viewportHeight, geometry.minPageHeight)) <= 1, '月历页面随可用高度展开：' + JSON.stringify(geometry));
            assert.ok(geometry.bottom >= 16 && geometry.bottom <= 32, '月历铺满页面剩余高度：' + JSON.stringify(geometry));
            if (geometry.pageHeight > geometry.viewportHeight) {
              await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
              assert.equal(await page.locator('.calgrid').evaluate(element => {
                const box = element.getBoundingClientRect();
                return box.bottom > 0 && box.bottom <= innerHeight;
              }), true, '矮窗口可滚动到月历底部');
            }
          }
          // Windows 175% 缩放下 28 CSS px 的 DOMRect 可能是 28.0000019。
          assert.ok(geometry.markers.every(marker => Math.abs(marker.width - 28) < 0.001
            && Math.abs(marker.height - 28) < 0.001 && marker.centered), '单双位日期都有固定正方形尺寸且居中');
          assert.ok(geometry.badges.every(delta => delta < 1), '单数字角标不被内边距撑成椭圆');
          if (process.env.WORKSTATION_VISUAL_OUTPUT) {
            await fs.mkdir(process.env.WORKSTATION_VISUAL_OUTPUT, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WORKSTATION_VISUAL_OUTPUT, colorScheme + '-' + width + '-' + height + '-calendar.png') });
          }
        }
      }
    });
    await check('月历任务改期与标题同行，改期可聚焦、关闭和保存', async () => {
      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        for (const width of [900, 1100, 1440]) {
          await resize(page, width);
          await page.goto(origin + '/plan?view=calendar&date=' + today);
          await page.evaluate(() => document.fonts.ready);
          await assertPage(page);
          assert.equal(await page.locator('#plan-day-tasks-title').innerText(), '到期');
          assert.equal(await page.locator('#plan-note-label').innerText(), '备注');
          assert.equal(await page.getByRole('button', { name: '保存备注', exact: true }).innerText(), '保存');
          const form = page.locator('[data-plan-task]').first();
          const summary = form.locator('.plan-task-reschedule > summary');
          const geometry = await form.evaluate(element => {
            const content = element.querySelector('.plan-task-content').getBoundingClientRect(), action = element.querySelector('summary').getBoundingClientRect();
            return { contentTop: content.top, actionTop: action.top, contentRight: content.right, actionLeft: action.left, height: element.getBoundingClientRect().height };
          });
          assert.ok(Math.abs(geometry.contentTop - geometry.actionTop) <= 1 && geometry.contentRight <= geometry.actionLeft);
          assert.ok(geometry.height < 90, '短标题与来源不再额外留一行日期');
          await summary.scrollIntoViewIfNeeded();
          await summary.focus();
          await page.keyboard.press('Enter');
          const date = form.locator('[name="due"]');
          await date.focus();
          await page.keyboard.press('Escape');
          assert.equal(await form.locator('details').getAttribute('open'), null);
          assert.equal(await summary.evaluate(element => element === document.activeElement), true);
          await page.keyboard.press('Enter');
          const changed = today.slice(0, 8) + (today.endsWith('01') ? '02' : '01');
          await date.fill(changed);
          assert.equal(await summary.innerText(), '待保存');
          await assertPage(page);
          await date.fill(today);
          assert.equal(await summary.innerText(), '改期');
        }
      }
      const form = page.locator('[data-plan-task]').first();
      const notePath = await form.locator('[name="path"]').inputValue();
      const changed = today.slice(0, 8) + (today.endsWith('01') ? '02' : '01');
      await form.locator('[name="due"]').fill(changed);
      await form.locator('[data-task-save]').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-plan-task]').length === 1);
      assert.ok((await fs.readFile(path.join(vault, 'notes', notePath), 'utf8')).includes('@' + changed));
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
