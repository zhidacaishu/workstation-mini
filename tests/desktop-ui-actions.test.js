const test = require('node:test');
const { waitForApi } = require('./desktop-test-utils');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { _electron: electron } = require('playwright-core');

test('菜单、搜索、项目状态、计划、建卡与复习的真实桌面交互', { timeout: 90000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-actions-desktop-'));
  const vault = path.join(root, 'vault');
  const userData = path.join(root, 'user');
  let app, page;
  const errors = [];
  let failed = false;
  async function check(name, fn) {
    await t.test(name, async () => { try { await fn(); } catch (error) { failed = true; throw error; } });
  }
  try {
    await fs.mkdir(path.join(vault, 'notes', 'experiments'), { recursive: true });
    await fs.mkdir(path.join(vault, 'cards'), { recursive: true });
    await fs.mkdir(path.join(vault, 'attachments'), { recursive: true });
    await fs.writeFile(path.join(vault, 'attachments', 'example.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    await fs.mkdir(path.join(userData, 'workstation-data'), { recursive: true });
    const now = new Date();
    const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    const note = '---\ntags: [交互标签]\n---\n\n# 交互测试\n\n可选择文字建卡\n\n**重点**\n\n[[missing]]\n\n![示例](attachments/example.svg)\n\n- [ ] 整理资料 @' + today + '\n';
    await fs.writeFile(path.join(vault, 'notes', 'sample.md'), note);
    await fs.writeFile(path.join(vault, 'notes', 'other.md'), '# 其他笔记\n\n其他正文\n\n[原图](attachments/example.svg)\n\n[丢了的图](attachments/gone.png)\n');
    await fs.writeFile(path.join(vault, 'notes', 'experiments', 'sample.md'),
      '---\ntitle: 项目测试\nstatus: running\ndeadline: 2020-01-01\nnext: 下一步测试\nresult: 结果测试\n---\n\n项目正文\n');
    await fs.writeFile(path.join(vault, 'cards', 'sample.md'), '---\ndeck: 交互卡组\n---\n\n## 题目\n\n答案\n');
    await fs.writeFile(path.join(userData, 'workstation-data', 'guide.json'), JSON.stringify({ step: 7, status: 'completed' }));
    await fs.writeFile(path.join(userData, 'workstation-data', 'settings.json'), JSON.stringify({
      schemaVersion: 1, vaultDir: vault, device: 'actions-smoke', syncEnabled: false
    }));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch(process.env.WORKSTATION_EXECUTABLE
      ? { executablePath: process.env.WORKSTATION_EXECUTABLE, args: ['--workstation-smoke-test', '--workstation-user-data=' + userData], env }
      : { args: [path.resolve(__dirname, '..'), '--workstation-user-data=' + userData], env });
    const mainOutput = [];
    app.process().stdout?.on('data', chunk => mainOutput.push(String(chunk)));
    page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('.workspace-sidebar');
    await waitForApi(page, '/api/index-status', status => status.phase === 'ready');
    const icon = await app.evaluate(({ app, nativeImage }) => {
      const root = app.isPackaged ? process.resourcesPath : app.getAppPath() + '/build';
      const file = root + '/' + (process.platform === 'win32' ? 'icon.ico' : 'icon.png');
      const image = nativeImage.createFromPath(file);
      return { file, empty: image.isEmpty(), size: image.getSize() };
    });
    assert.equal(icon.empty, false, '窗口图标可以从实际运行路径加载：' + icon.file);
    assert.ok(icon.size.width >= 16 && icon.size.height >= 16);
    const origin = new URL(page.url()).origin;
    const visit = route => page.goto(origin + route);
    const visible = selector => page.locator(selector).isVisible();

    await check('更多操作点击外部、Esc 和移出焦点收起，内部操作可用', async () => {
      await visit('/note/sample.md');
      assert.equal(await page.locator('.prose strong').textContent(), '重点');
      assert.equal(await page.locator('.prose img').evaluate(async image => { await image.decode(); return image.naturalWidth; }), 10);
      const trigger = page.locator('.note-more summary');
      await trigger.click();
      assert.equal(await visible('.note-more-menu'), true);
      await page.locator('.note-title-row h1').click();
      assert.equal(await visible('.note-more-menu'), false, '点击标题应关闭菜单');
      await trigger.click();
      await page.keyboard.press('Escape');
      assert.equal(await visible('.note-more-menu'), false, 'Esc 应关闭菜单');
      assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
      await trigger.click();
      await page.keyboard.press('Tab');
      assert.equal(await visible('.note-more-menu'), true);
      // 菜单里有三项：阅读行宽、版本历史、删除。
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      assert.equal(await visible('.note-more-menu'), true);
      await page.keyboard.press('Tab');
      assert.equal(await visible('.note-more-menu'), false, '移出焦点应关闭菜单');
      await trigger.click();
      page.once('dialog', dialog => dialog.dismiss().catch(() => {}));
      await page.getByRole('button', { name: '删除笔记', exact: true }).click();
      assert.equal(await fs.readFile(path.join(vault, 'notes', 'sample.md'), 'utf8'), note);
      await page.getByRole('link', { name: '版本历史与草稿', exact: true }).click();
      assert.ok(page.url().includes('/history?path=sample.md'));
    });
    await check('点附件链接交给系统默认应用，主窗口不跳到原始文件', async () => {
      await visit('/note/other.md');
      // 导航被主进程取消；用 Playwright 的 click 会一直等这次导航结束，所以直接在页面里点。
      await page.evaluate(() => {
        const links = [...document.querySelectorAll('.prose a')];
        links.find(link => link.textContent === '原图').click();
        links.find(link => link.textContent === '丢了的图')
          .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true, metaKey: true }));
      });
      const opened = () => mainOutput.join('');
      const expected = [/用系统默认应用打开：attachments\/example\.svg/, /打不开：资料库里没有 attachments\/gone\.png/];
      // 两次路径校验并行完成，缺失文件可能先返回；必须等两条结果，不能假定日志顺序。
      const deadline = Date.now() + 5000;
      while (!expected.every(pattern => pattern.test(opened())) && Date.now() < deadline) {
        await page.waitForTimeout(50);
      }
      for (const pattern of expected) assert.match(opened(), pattern);
      assert.ok(page.url().endsWith('/note/other.md'), page.url());
      assert.equal(await visible('.workspace-sidebar'), true);
    });
    await check('搜索面板内部空白不关闭，遮罩与 Esc 关闭，搜索结果可打开', async () => {
      await visit('/');
      await page.locator('[data-palette-open]').click();
      await page.waitForSelector('.palette-item');
      const box = await page.locator('#palette').boundingBox();
      await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
      assert.equal(await visible('#palette'), true, '面板内边距不应关闭');
      await page.mouse.click(820, 620);
      assert.equal(await visible('#palette'), false);
      await page.locator('[data-palette-open]').click();
      await page.keyboard.press('Escape');
      assert.equal(await visible('#palette'), false);
      await page.locator('[data-palette-open]').click();
      await page.locator('.palette-input').fill('交互测试');
      await page.locator('.palette-item').filter({ hasText: '交互测试' }).first().click();
      await page.waitForURL('**/note/sample.md');
    });
    await check('资料库搜索、标签和分区筛选、清除及健康页入口', async () => {
      await visit('/search');
      await page.locator('[name="q"]').fill('交互测试');
      await page.locator('[name="q"]').press('Enter');
      await page.waitForURL('**/search?**');
      assert.equal(await page.locator('.library-document').count(), 1);
      await page.getByRole('link', { name: '清除', exact: true }).click();
      await page.locator('[name="tag"]').selectOption('交互标签');
      await page.waitForFunction(() => new URL(location.href).searchParams.get('tag') === '交互标签');
      await page.waitForLoadState('load');
      assert.equal(await page.locator('.library-document').count(), 1);
      await page.locator('[name="section"]').selectOption('experiments');
      await page.waitForFunction(() => new URL(location.href).searchParams.get('section') === 'experiments');
      await page.waitForLoadState('load');
      assert.equal(await page.locator('.library-document').count(), 0);
      await page.getByRole('link', { name: '清除', exact: true }).click();
      assert.equal(await page.locator('.library-document').count(), 3);
      await page.getByRole('link', { name: '资料库健康', exact: true }).click();
      await page.waitForURL('**/health');
      assert.equal(await page.locator('.health-tile').count(), 5);
    });
    await check('项目状态变更立即更新截止提示和结果，刷新后相同', async () => {
      await visit('/board/experiment');
      const card = page.locator('[data-board-card]');
      assert.match(await card.innerText(), /逾期/);
      await card.locator('select').selectOption('done');
      await page.waitForFunction(() => document.querySelector('[data-board-card]')?.dataset.status === 'done');
      await page.waitForLoadState('load');
      assert.doesNotMatch(await card.innerText(), /逾期|下一步测试/);
      assert.match(await card.innerText(), /结果测试/);
      const before = await card.innerText();
      await page.reload();
      assert.equal(await card.innerText(), before);
      await card.locator('select').selectOption('running');
      await page.waitForFunction(() => document.querySelector('[data-board-card]')?.dataset.status === 'running');
      await page.waitForLoadState('load');
      assert.match(await card.innerText(), /逾期/);
      assert.match(await card.innerText(), /下一步测试/);
      assert.doesNotMatch(await card.innerText(), /结果测试/);
      await card.locator('select').selectOption('abandoned');
      await page.waitForFunction(() => document.querySelector('[data-board-card]')?.dataset.status === 'abandoned');
      await page.waitForLoadState('load');
      assert.doesNotMatch(await card.innerText(), /逾期/);
    });
    await check('计划改期、完成和重新打开写回 Markdown', async () => {
      await visit('/plan?view=list');
      const form = page.locator('[data-plan-task]');
      await form.locator('[name="due"]').fill('2030-02-03');
      await form.locator('[data-task-save]').click();
      await page.waitForFunction(() => document.querySelector('[data-plan-task] [name="due"]')?.value === '2030-02-03' && !document.querySelector('[data-plan-task]')?.hasAttribute('aria-busy'));
      await page.waitForLoadState('load');
      await form.locator('[name="done"]').check();
      await page.waitForSelector('.plan-empty');
      await page.waitForLoadState('load');
      await page.getByRole('link', { name: '已完成', exact: true }).click();
      await form.locator('[name="done"]').uncheck();
      await page.waitForSelector('.plan-empty');
      await page.waitForLoadState('load');
      assert.match(await fs.readFile(path.join(vault, 'notes', 'sample.md'), 'utf8'), /- \[ \] 整理资料 @2030-02-03/);
    });
    await check('未保存改期不会被其他任务完成或页面跳转丢弃', async () => {
      await fs.writeFile(path.join(vault, 'notes', 'another-task.md'), '# 另一任务\n\n- [ ] task B @2030-02-04\n');
      await visit('/plan?view=list');
      await page.evaluate(() => fetch('/api/reindex', { method: 'POST' }));
      await page.reload();
      const forms = page.locator('[data-plan-task]');
      const first = forms.filter({ has: page.locator('[name="path"][value="sample.md"]') });
      const second = forms.filter({ has: page.locator('[name="path"][value="another-task.md"]') });
      await first.locator('[name="due"]').fill('2031-05-06');
      await second.locator('[name="done"]').click();
      assert.equal(await second.locator('[name="done"]').isChecked(), false);
      assert.equal(await first.locator('[name="due"]').inputValue(), '2031-05-06');
      assert.match(await page.locator('#toast-region').innerText(), /先保存或还原/);
      page.once('dialog', dialog => dialog.dismiss().catch(() => {}));
      await page.getByRole('link', { name: '笔记', exact: true }).click();
      assert.equal(await first.locator('[name="due"]').inputValue(), '2031-05-06');
      await first.locator('[data-task-save]').click();
      await page.waitForFunction(() => document.querySelector('[name="due"][value="2031-05-06"]') && !document.querySelector('[aria-busy="true"][data-task-form]'));
      // 新DOM已出现时defer脚本未必执行完，下一次编辑要等本次重载完成。
      await page.waitForLoadState('load');
      await page.route('**/tasks/update', route => route.fulfill({
        status: 409, contentType: 'application/json', body: JSON.stringify({ message: '模拟版本冲突' })
      }));
      try {
        await first.locator('[name="due"]').fill('2032-06-07');
        await first.locator('[data-task-save]').click();
        await page.waitForFunction(() => document.querySelector('.toast.is-error')?.textContent.includes('模拟版本冲突'));
        assert.equal(await first.locator('[name="due"]').isDisabled(), false);
        assert.equal(await second.locator('[name="due"]').isDisabled(), false);
        assert.equal(await first.locator('[name="due"]').inputValue(), '2032-06-07');
      } finally {
        await page.unroute('**/tasks/update');
      }
      let release;
      let intercepted;
      const arrived = new Promise(resolve => { intercepted = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      let requests = 0;
      await page.route('**/tasks/update', async route => {
        requests += 1; intercepted(); await gate; await route.continue();
      });
      try {
        await first.locator('[data-task-save]').click();
        await arrived;
        assert.equal(await second.locator('[name="done"]').isDisabled(), true);
        assert.equal(await second.locator('[name="due"]').isDisabled(), true, '请求期间禁止产生另一项改期输入');
        assert.equal(requests, 1, '另一任务保存期间不并发提交');
        release();
        await page.waitForFunction(() => document.querySelector('[name="due"][value="2032-06-07"]') && !document.querySelector('[aria-busy="true"][data-task-form]'));
        await page.waitForLoadState('load');
      } finally {
        release();
        await page.unroute('**/tasks/update');
      }
      await second.locator('[name="done"]').check();
      await page.waitForFunction(() => document.querySelectorAll('[data-plan-task]').length === 1);
      await page.waitForLoadState('load');
      assert.equal(await first.locator('[name="due"]').inputValue(), '2032-06-07');
    });
    await check('月历备注保存、清空、未保存保护和月份切换', async () => {
      await visit('/plan?view=calendar&date=' + today);
      const text = page.locator('#calendar-note');
      const submitted = '当天备注测试\n- [ ] 核对图表 @' + today;
      await text.fill(submitted);
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route('**/plan/notes', async route => { await gate; await route.continue(); });
      try {
        const arrived = page.waitForRequest(r => r.url().endsWith('/plan/notes'));
        await page.getByRole('button', { name: '保存备注', exact: true }).click();
        await arrived;
        await text.fill(submitted + '\n继续写');
        release();
        await page.waitForFunction(() => document.querySelector('[data-calendar-status]').textContent.includes('还有未保存的更改'));
      } finally {
        release();
        await page.unroute('**/plan/notes');
      }
      assert.equal(await text.inputValue(), submitted + '\n继续写');
      const updated = '前面插入一行\n' + submitted + '\n- [ ] 复核样本 @' + today;
      await text.fill(updated);
      await page.getByRole('button', { name: '保存备注', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-calendar-status]').textContent === '已保存');
      assert.equal(await visible('[data-calendar-note-link]'), true);
      const day = page.locator('[aria-current="date"]');
      assert.match(await day.innerText(), /复核样本/);
      const task = page.locator('[data-plan-task]').filter({ hasText: '核对图表' });
      const changed = page.waitForResponse(r => r.url().endsWith('/tasks/update'));
      await task.getByRole('checkbox').check();
      assert.equal((await changed).status(), 200);
      await task.waitFor({ state: 'detached' });
      assert.match(await fs.readFile(path.join(vault, 'notes', 'calendar', today + '.md'), 'utf8'), /- \[x\] 核对图表/);
      await text.fill('未保存内容');
      page.once('dialog', dialog => dialog.dismiss().catch(() => {}));
      await page.locator('.plan-view-switch a').filter({ hasText: '列表' }).click();
      assert.equal(await text.inputValue(), '未保存内容');
      await text.fill('');
      await page.getByRole('button', { name: '保存备注', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-calendar-status]').textContent === '已清空');
      assert.equal(await visible('[data-calendar-note-link]'), false);
      await assert.rejects(fs.access(path.join(vault, 'notes', 'calendar', today + '.md')), { code: 'ENOENT' });
      await page.getByRole('link', { name: '下个月', exact: true }).click();
      assert.notEqual(new URL(page.url()).searchParams.get('month'), today.slice(0, 7));
      await page.getByRole('link', { name: '今天', exact: true }).click();
      assert.equal(await page.locator('[aria-current="date"]').getAttribute('data-calendar-day'), today);
    });
    await check('编辑保存、缺失双链新建、建卡取消和保存', async () => {
      await visit('/note/sample.md');
      await page.getByRole('link', { name: '编辑', exact: true }).click();
      await page.locator('[name="body"]').fill(note + '\n新增内容\n');
      await page.locator('[data-editor-save]').click();
      await page.waitForURL('**/note/sample.md');
      assert.match(await page.locator('.prose').innerText(), /新增内容/);
      await page.locator('.prose .wikilink-missing').click();
      await page.waitForSelector('[data-new-note="1"]');
      await page.locator('[name="body"]').fill('# 缺失笔记\n');
      await page.locator('[data-editor-save]').click();
      await page.waitForURL('**/note/missing.md');
      await visit('/note/sample.md');
      const selectText = () => page.locator('.prose p').first().evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      });
      await selectText();
      await page.getByRole('button', { name: '建卡片', exact: true }).click();
      await page.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(await page.locator('.selection-form').count(), 0);
      await selectText();
      await page.getByRole('button', { name: '建卡片', exact: true }).click();
      await page.locator('.selection-form [name="front"]').fill('新增卡片');
      await page.locator('.selection-form [name="back"]').fill('新增答案');
      await page.locator('.selection-form [data-save]').click();
      await page.waitForSelector('.selection-form', { state: 'detached' });
      assert.match(await fs.readFile(path.join(vault, 'cards', 'inbox.md'), 'utf8'), /新增卡片/);
    });
    await check('页面淡入期间真实坐标点击链接、按钮和保存仍然有效', async () => {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      const styles = '**/static/styles.css';
      // 在浏览器里读取实际样式，沿用桌面壳的内部请求认证。
      const sourceStyles = await page.evaluate(async () => {
        const response = await fetch('/static/styles.css', { cache: 'no-store' });
        if (!response.ok) throw new Error('读取样式失败：' + response.status);
        return response.text();
      });
      await page.route(styles, route => route.fulfill({
        status: 200, contentType: 'text/css; charset=utf-8', headers: { 'cache-control': 'no-store' },
        body: sourceStyles + '\n.workspace-main { animation-duration: 3s !important; }\n'
          + '::view-transition-old(root), ::view-transition-new(root) { animation-duration: 3s !important; }\n'
      }));
      const duringFade = async () => {
        try {
          await page.waitForFunction(() => document.getAnimations().some(animation =>
            animation.playState === 'running' && animation.effect?.getComputedTiming().duration >= 2500));
        } catch (error) {
          console.error('[fade-diagnostic]', await page.evaluate(() => ({
            url: location.href,
            motion: matchMedia('(prefers-reduced-motion: reduce)').matches,
            name: getComputedStyle(document.querySelector('.workspace-main')).animationName,
            duration: getComputedStyle(document.querySelector('.workspace-main')).animationDuration,
            animations: document.getAnimations().map(animation => ({ state: animation.playState, timing: animation.effect?.getComputedTiming() }))
          })));
          throw error;
        }
      };
      const clickAt = async locator => {
        const box = await locator.boundingBox();
        assert.ok(box);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      };
      try {
        await visit('/decks');
        await duringFade();
        await Promise.all([
          page.waitForURL(url => url.pathname === '/review'),
          clickAt(page.locator('.page-head a[href="/review"]'))
        ]);
        await duringFade();
        await clickAt(page.locator('#review-reveal'));
        await page.waitForSelector('#review-back:not([hidden])');
        await visit('/edit/sample.md');
        await duringFade();
        const body = page.locator('[name="body"]');
        await body.fill(await body.inputValue() + '\n动画期间保存验证\n');
        await Promise.all([
          page.waitForURL('**/note/sample.md'),
          clickAt(page.locator('[data-editor-save]'))
        ]);
        assert.match(await fs.readFile(path.join(vault, 'notes', 'sample.md'), 'utf8'), /动画期间保存验证/);
      } finally {
        await page.unroute(styles);
      }
    });
    await check('鼠标显示答案后数字快捷键仍可评分，评分按钮完成复习', async () => {
      await visit('/review?deck=' + encodeURIComponent('交互卡组'));
      await page.locator('#review-reveal').focus();
      await page.locator('#review-reveal').click();
      assert.equal(await page.locator('#reviewer').evaluate(element => element === document.activeElement), true);
      let release;
      const wait = new Promise(resolve => { release = resolve; });
      await page.route('**/review/answer', async route => { await wait; await route.continue(); });
      await page.keyboard.press('3');
      await page.waitForFunction(() => document.querySelector('#reviewer').getAttribute('aria-busy') === 'true');
      page.once('dialog', dialog => dialog.dismiss().catch(() => {}));
      await page.getByRole('link', { name: '笔记', exact: true }).click();
      assert.equal(new URL(page.url()).pathname, '/review', '评分未保存时不能直接离开');
      release();
      await page.waitForSelector('#review-done', { state: 'visible', timeout: 2000 });
      assert.match(await page.locator('#review-summary').textContent(), /复习了 1 张/);
      await page.unroute('**/review/answer');
      await Promise.all([
        page.waitForURL(url => url.pathname === '/decks'),
        page.getByRole('link', { name: '卡组', exact: true }).click()
      ]);
      // 等页面切换及有限动画结束，再进行下一次点击。
      await page.evaluate(async () => {
        await document.activeViewTransition?.finished.catch(() => {});
        await Promise.allSettled(document.getAnimations()
          .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
          .map(animation => animation.finished));
      });
      const start = page.locator('.page-head a[href="/review"]');
      assert.match(await start.textContent(), /开始复习/);
      const expectedQueue = await page.evaluate(async () => {
        const html = await fetch('/review').then(response => response.text());
        const doc = new DOMParser().parseFromString(html, 'text/html');
        return JSON.parse(decodeURIComponent(doc.getElementById('reviewer')?.dataset.queue || '%5B%5D'));
      });
      assert.ok(expectedQueue.some(card => card.front.includes('新增卡片')), '新增卡片仍在待复习队列');
      try {
        await Promise.all([
          page.waitForURL(url => url.pathname === '/review' && !url.searchParams.has('deck')),
          start.click()
        ]);
        await page.locator('#review-reveal').click();
      } catch (error) {
        console.error('[review-navigation]', JSON.stringify({ url: page.url(), body: await page.locator('body').innerText(), expectedQueue }));
        throw error;
      }
      await page.locator('[data-rating="4"]').click();
      await page.waitForSelector('#review-done', { state: 'visible' });
    });
    await check('阅读页直接勾选待办，写回原文那一行', async () => {
      await visit('/note/sample.md');
      const box = page.locator('.prose input.task-toggle');
      assert.equal(await box.count(), 1);
      assert.equal(await page.locator('.prose time.task-due').innerText(), '今天');
      const file = () => fs.readFile(path.join(vault, 'notes', 'sample.md'), 'utf8');
      await box.check();
      await page.waitForFunction(() => document.querySelector('.prose li.task-item.is-done') && !document.querySelector('.prose input.task-toggle').disabled);
      assert.match(await file(), /- \[x\] 整理资料 @/);
      await box.uncheck();
      await page.waitForFunction(() => !document.querySelector('.prose li.task-item.is-done') && !document.querySelector('.prose input.task-toggle').disabled);
      assert.match(await file(), /- \[ \] 整理资料 @/);
      await page.reload();
      assert.equal(await box.isChecked(), false);
    });
    await check('新建笔记先写标题，路径自动生成，重名换成「标题 2」', async () => {
      for (const expected of ['inbox/桌面新建.md', 'inbox/桌面新建 2.md']) {
        await visit('/new');
        await page.locator('[data-note-title]').fill('桌面新建');
        assert.equal(await page.locator('[name="path"]').inputValue(), 'inbox/桌面新建.md');
        assert.match(await page.locator('[name="body"]').inputValue(), /^# 桌面新建\n/);
        await page.locator('[name="body"]').fill('# 桌面新建\n\n正文 ' + expected + '\n');
        assert.equal(await page.locator('[data-note-title]').inputValue(), '桌面新建');
        await page.locator('[data-editor-save]').click();
        await page.waitForURL(url => decodeURIComponent(url.pathname) === '/note/' + expected);
        assert.match(await fs.readFile(path.join(vault, 'notes', ...expected.split('/')), 'utf8'), new RegExp('正文 ' + expected));
      }
    });
    await check('保留名称可保存，研究项目中的美元符号原样保存', async () => {
      await visit('/new');
      await page.locator('[data-note-title]').fill('CON.txt');
      assert.equal(await page.locator('[name="path"]').inputValue(), 'inbox/CON_.txt.md');
      await page.locator('[data-editor-save]').click();
      await page.waitForURL(url => url.pathname === '/note/inbox/CON_.txt.md');
      assert.match(await fs.readFile(path.join(vault, 'notes', 'inbox', 'CON_.txt.md'), 'utf8'), /^# CON\.txt/);
      await visit('/new?folder=experiments');
      const title = '公式 $$ E=mc^2 $$';
      await page.locator('[data-note-title]').fill(title);
      await page.locator('[data-editor-save]').click();
      await page.waitForURL(url => url.pathname.startsWith('/note/experiments/'));
      assert.equal(await page.locator('.note-title-row h1').innerText(), title);
      const savedPath = decodeURIComponent(new URL(page.url()).pathname.slice('/note/'.length));
      assert.match(await fs.readFile(path.join(vault, 'notes', savedPath), 'utf8'), /title: 公式 \$\$ E=mc\^2 \$\$/);
    });
    await check('卡片列表里改正面、暂停、恢复和删除，复习记录保留', async () => {
      const deckFile = path.join(vault, 'cards', 'sample.md');
      await visit('/decks');
      await page.locator('.deck-name').filter({ hasText: '交互卡组' }).click();
      await page.waitForURL(url => url.pathname === '/cards');
      await page.locator('.card-row-front').filter({ hasText: '题目' }).click();
      await page.waitForURL(url => url.pathname === '/cards/edit');
      assert.equal(await page.locator('[data-nav="review"]').getAttribute('aria-current'), 'page');
      const original = await fs.readFile(deckFile, 'utf8');
      await fs.appendFile(deckFile, '\n## 同步新增的卡\n');
      await page.locator('[name="front"]').fill('冲突的正面');
      await page.locator('[name="back"]').fill('冲突的背面');
      await page.locator('[name="deckFile"]').fill('另一个卡组');
      await page.locator('[name="suspended"]').check();
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.locator('[data-card-error]').waitFor();
      assert.match(await page.locator('[data-card-error]').innerText(), /已在别处修改/);
      assert.equal(await page.locator('[name="front"]').inputValue(), '冲突的正面');
      assert.equal(await page.locator('[name="back"]').inputValue(), '冲突的背面');
      assert.equal(await page.locator('[name="deckFile"]').inputValue(), '另一个卡组');
      assert.equal(await page.locator('[name="suspended"]').isChecked(), true);
      await fs.writeFile(deckFile, original);
      await page.locator('[name="deckFile"]').fill('sample');
      await page.locator('[name="suspended"]').uncheck();
      await page.locator('[name="front"]').fill('题目（改）');
      await page.locator('[name="back"]').fill('改过的答案');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForURL(url => url.pathname === '/cards');
      const row = page.locator('.card-row').filter({ hasText: '题目（改）' });
      assert.doesNotMatch(await row.locator('.card-state').innerText(), /新卡/, '改正面后复习记录仍在');
      const changed = await fs.readFile(deckFile, 'utf8');
      assert.match(changed, /## 题目（改）\n<!-- workstation:card:v1 /);
      assert.match(changed, /改过的答案/);
      await row.getByRole('button', { name: /暂停复习/ }).click();
      await page.waitForFunction(() => document.querySelector('.card-row.is-suspended'));
      await page.waitForLoadState('load');
      assert.match(await fs.readFile(deckFile, 'utf8'), /"suspended":true/);
      await page.locator('.card-row').filter({ hasText: '题目（改）' }).getByRole('button', { name: /恢复复习/ }).click();
      await page.waitForFunction(() => !document.querySelector('.card-row.is-suspended'));
      await page.waitForLoadState('load');
      await fs.writeFile(path.join(vault, 'cards', 'trash.md'), '---\ndeck: 待删卡组\n---\n\n## 要删的卡\n\n内容\n');
      await visit('/cards?deck=' + encodeURIComponent('待删卡组'));
      await page.locator('.card-row-front').filter({ hasText: '要删的卡' }).click();
      page.once('dialog', dialog => dialog.accept().catch(() => {}));
      await page.getByRole('button', { name: '删除这张卡', exact: true }).click();
      await page.waitForURL(url => url.pathname === '/cards' && url.searchParams.get('deck') === '待删卡组');
      assert.equal(await page.locator('.card-row').count(), 0);
      assert.doesNotMatch(await fs.readFile(path.join(vault, 'cards', 'trash.md'), 'utf8'), /要删的卡/);
    });
    await check('复习中「忘了」的卡本轮末尾重学，可直接暂停当前这张', async () => {
      await fs.writeFile(path.join(vault, 'cards', 'relearn.md'), '---\ndeck: 重学卡组\n---\n\n## Q1\n\nA1\n\n## Q2\n\nA2\n\n## Q3\n\nA3\n');
      await visit('/review?deck=' + encodeURIComponent('重学卡组'));
      const front = async () => (await page.locator('#review-front').innerText()).trim();
      const rate = async rating => {
        await page.locator('#review-reveal').click();
        await page.keyboard.press(String(rating));
      };
      assert.equal(await front(), 'Q1');
      assert.equal(await visible('#review-relearn'), false);
      await rate(1);
      assert.equal(await front(), 'Q2');
      assert.equal(await page.locator('#review-remaining').innerText(), '3');
      await page.locator('#review-suspend').click();
      await page.waitForFunction(() => document.querySelector('#review-front').textContent.trim() === 'Q3');
      assert.match(await fs.readFile(path.join(vault, 'cards', 'relearn.md'), 'utf8'), /## Q2\n<!-- workstation:card:v1 \{[^}]*"suspended":true/);
      assert.match(await page.locator('#review-edit').getAttribute('href'), /^\/cards\/edit\?id=/);
      // 暂停按钮异步完成后也要交回题面，连续快捷键不能再次触发暂停。
      await page.keyboard.press('Space');
      await page.waitForSelector('#review-back:not([hidden])');
      await page.keyboard.press('3');
      assert.equal(await front(), 'Q1');
      assert.equal(await visible('#review-relearn'), true);
      await rate(3);
      await page.waitForSelector('#review-done', { state: 'visible' });
      assert.match(await page.locator('#review-summary').textContent(), /复习了 2 张，其中 1 张本轮重学过/);
      await visit('/decks');
      assert.match(await page.locator('tr').filter({ hasText: '重学卡组' }).innerText(), /已暂停 1/);
    });
    await check('设置分组、同步反馈、恢复窗口和只读模式', async () => {
      await visit('/');
      const opened = app.waitForEvent('window');
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('show-settings').click());
      const settings = await opened;
      settings.setDefaultTimeout(5000);
      settings.on('pageerror', error => errors.push(error.message));
      await settings.waitForSelector('body[data-settings-state="clean"]');
      for (const id of ['system', 'workspace', 'appearance', 'sync', 'system']) {
        await settings.locator('[data-settings-nav] a[href="#' + id + '"]').click();
        assert.equal(await settings.locator('[data-settings-nav] a[aria-current="location"]').getAttribute('href'), '#' + id);
        await settings.waitForFunction(id => {
          const target = document.getElementById(id);
          const desired = Math.min(target.getBoundingClientRect().top + scrollY - 16, document.documentElement.scrollHeight - innerHeight);
          return Math.abs(scrollY - desired) < 2;
        }, id);
        await settings.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await settings.locator('[data-settings-nav] a[aria-current="location"]').getAttribute('href'), '#' + id);
      }
      await settings.mouse.move(700, 400);
      await settings.mouse.wheel(0, -2000);
      await settings.waitForFunction(() => scrollY === 0 && document.querySelector('[data-settings-nav] a[aria-current="location"]').hash === '#workspace');
      assert.equal(await settings.locator('#sync-now').isDisabled(), true, '同步关闭时禁止手动同步');
      const recoveryOpened = app.waitForEvent('window');
      await settings.locator('#open-recovery').click();
      const recovery = await recoveryOpened;
      recovery.setDefaultTimeout(5000);
      recovery.on('pageerror', error => errors.push(error.message));
      await recovery.waitForSelector('#source-panel', { state: 'visible' });
      assert.equal(await recovery.locator('#start').isDisabled(), true);
      await recovery.locator('label').filter({ has: recovery.locator('[name="sourceKind"][value="local"]') }).click();
      assert.equal(await recovery.locator('#local-source').isVisible(), true);
      assert.equal(await recovery.locator('#git-source').isVisible(), false);
      await recovery.close();
      await settings.locator('[name="readOnly"]').check();
      const refreshed = app.waitForEvent('window');
      await settings.locator('#save').click();
      await settings.waitForFunction(() => document.querySelector('#message').textContent === '设置已保存。');
      page = await refreshed;
      page.on('pageerror', error => errors.push(error.message));
      await page.waitForSelector('body.is-readonly');
      assert.equal(await page.locator('.workspace-sidebar').evaluate(e => e.scrollWidth <= e.clientWidth), true);
      assert.equal(await page.locator('.readonly-status').isVisible(), true);
      const readonlyOrigin = new URL(page.url()).origin;
      await page.goto(readonlyOrigin + '/note/sample.md');
      assert.equal(await page.locator('.note-actions a[href^="/edit"], .note-actions form[action="/delete"], .note-actions a[href^="/history"], .workspace-create, .selection-card').count(), 0);
      // 只读时「更多」里只剩阅读行宽这一项：它只改显示，不写资料库。
      assert.equal(await page.locator('.note-more-menu > *').count(), 1);
      assert.equal(await page.locator('.note-more-menu form[action="/prefs/reading-width"]').count(), 1);
      await page.goto(readonlyOrigin + '/board/experiment');
      assert.equal(await page.locator('.statusform').count(), 0);
      await page.goto(readonlyOrigin + '/plan?view=list');
      assert.equal(await page.locator('[data-task-form]').count(), 0);
      const due = page.locator('.plan-task-form time[datetime]:not([datetime=""])').first();
      await due.hover();
      assert.equal(await due.isVisible(), true);
      await page.goto(readonlyOrigin + '/plan?view=calendar');
      assert.equal(await page.locator('[data-calendar-form]').count(), 0);
      assert.equal(await page.locator('.calendar-note-readonly').count(), 1);
      await settings.close();
    });
    assert.deepEqual(errors, []);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (failed || t.signal.aborted) {
      await page?.screenshot({ path: path.join(root, 'failure.png'), fullPage: true, timeout: 5000 }).catch(() => {});
      console.error('[desktop-actions] artifacts preserved at ' + root);
    }
    if (app) {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    }
    if (!failed && !t.signal.aborted) await fs.rm(root, { recursive: true, force: true });
  }
});
