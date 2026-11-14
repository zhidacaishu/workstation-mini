// 真实桌面窗口里走一遍第五轮新增的交互：编辑器的续列表、缩进、[[ 补全、贴图、分栏预览，
// 计划页快速添加，复习的挖空就地显示和撤销，代码块复制按钮，以及设置窗口里的冲突选边。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('playwright-core');

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function launch(userData) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch(process.env.WORKSTATION_EXECUTABLE
    ? { executablePath: process.env.WORKSTATION_EXECUTABLE, args: ['--workstation-smoke-test', '--workstation-user-data=' + userData], env }
    : { args: [path.resolve(__dirname, '..'), '--workstation-user-data=' + userData], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  await page.waitForSelector('.workspace-sidebar');
  await page.waitForFunction(async () => (await fetch('/api/index-status').then(response => response.json())).phase === 'ready');
  return { app, page, origin: new URL(page.url()).origin };
}

async function writeSettings(userData, settings) {
  await fs.mkdir(path.join(userData, 'workstation-data'), { recursive: true });
  await fs.writeFile(path.join(userData, 'workstation-data', 'guide.json'), JSON.stringify({ step: 7, status: 'completed' }));
  await fs.writeFile(path.join(userData, 'workstation-data', 'settings.json'), JSON.stringify({ schemaVersion: 1, ...settings }));
}

async function close(app) {
  if (!app) return;
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}

test('编辑器、快速添加、复习撤销在真实窗口里可用', { timeout: 120000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-editing-desktop-'));
  const vault = path.join(root, 'vault');
  const userData = path.join(root, 'user');
  let app;
  const errors = [];
  let failed = false;
  async function check(name, fn) {
    await t.test(name, async () => { try { await fn(); } catch (error) { failed = true; throw error; } });
  }
  try {
    await fs.mkdir(path.join(vault, 'notes', 'inbox'), { recursive: true });
    await fs.mkdir(path.join(vault, 'cards'), { recursive: true });
    await fs.writeFile(path.join(vault, 'notes', 'inbox', '草稿.md'), '# 草稿\n\n- 第一项\n');
    await fs.writeFile(path.join(vault, 'notes', 'inbox', '排队论读书笔记.md'), '# 排队论读书笔记\n\n```python\nprint("hi")\n```\n');
    await fs.writeFile(path.join(vault, 'cards', 'q.md'), '---\ndeck: 排队论\n---\n\n## 稳定条件\n\n负载 {{ρ < 1}} 时稳定\n');
    await writeSettings(userData, { vaultDir: vault, device: 'editing-smoke', syncEnabled: false });
    const launched = await launch(userData);
    app = launched.app;
    const { page, origin } = launched;
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    const visit = route => page.goto(origin + route);
    const area = () => page.locator('textarea[data-md-editor]').first();
    const value = () => area().inputValue();

    await check('回车续列表，空项再回车结束列表，Tab 缩进', async () => {
      await visit('/edit/inbox/' + encodeURIComponent('草稿.md'));
      await area().click();
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Enter');
      await page.keyboard.type('第二项');
      assert.match(await value(), /- 第一项\n- 第二项$/);
      await page.keyboard.press('Tab');
      assert.match(await value(), /- 第一项\n {2}- 第二项$/);
      await page.keyboard.press('Shift+Tab');
      assert.match(await value(), /- 第一项\n- 第二项$/);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      assert.match(await value(), /- 第二项\n\n?$/, '空的列表项再回车就结束列表');
      assert.doesNotMatch(await value(), /\n- \n?$/);
    });

    await check('回车续引用，空引用再回车结束', async () => {
      await area().fill('> 引用内容');
      await area().press('End');
      await page.keyboard.press('Enter');
      assert.equal(await value(), '> 引用内容\n> ');
      await page.keyboard.press('Enter');
      assert.equal(await value(), '> 引用内容\n');
      await area().fill('# 草稿\n\n- 第一项\n');
      await area().press('End');
    });

    await check('[[ 弹出补全，回车写入能解析的目标', async () => {
      await page.keyboard.type('见 [[排队');
      await page.waitForSelector('#link-suggest li');
      assert.match(await page.locator('#link-suggest li').first().textContent(), /排队论读书笔记/);
      await page.keyboard.press('Enter');
      assert.match(await value(), /见 \[\[排队论读书笔记\]\]$/);
      assert.equal(await page.locator('#link-suggest').isVisible().catch(() => false), false);
      // Esc 关掉补全，不离开编辑页。
      await page.keyboard.type(' [[没有这篇');
      await page.waitForSelector('#link-suggest');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#link-suggest').isVisible().catch(() => false), false);
      assert.match(page.url(), /\/edit\//);
    });

    await check('分栏预览跟着输入更新，开关记得住', async () => {
      const toggle = page.locator('[data-preview-toggle]');
      if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
      await page.waitForFunction(() => /排队论读书笔记/.test(document.querySelector('#editor-preview')?.textContent || ''));
      assert.equal(await page.locator('#editor-preview h1').textContent(), '草稿');
      assert.equal(await page.locator('#editor-preview a').first().getAttribute('href'), '/note/inbox/' + encodeURIComponent('排队论读书笔记.md'));
      await page.keyboard.type('\n\n## 新的小节');
      await page.waitForFunction(() => [...document.querySelectorAll('#editor-preview h2')].some(node => node.textContent === '新的小节'));
      await toggle.click();
      assert.equal(await page.locator('#editor-preview').isVisible(), false);
      await toggle.click();
      assert.equal(await page.locator('#editor-preview').isVisible(), true);
    });

    await check('两次粘图乱序返回仍对应原位置，保持用户光标与焦点', async () => {
      await area().fill('# 草稿\n\n![正在保存图片…]()\nabc');
      const result = await area().evaluate(async (textarea, base64) => {
        const originalFetch = window.fetch;
        const pending = [];
        window.fetch = (url, options) => String(url) === '/api/attachments'
          ? new Promise(resolve => pending.push(resolve)) : originalFetch(url, options);
        const paste = () => {
          const transfer = new DataTransfer();
          transfer.items.add(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], 'image.png', { type: 'image/png' }));
          textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
        };
        try {
          const from = textarea.value.indexOf('abc');
          textarea.focus(); textarea.setSelectionRange(from, from); paste();
          textarea.setSelectionRange(textarea.value.length, textarea.value.length); paste();
          const anchor = textarea.value.indexOf('abc') + 1;
          textarea.setSelectionRange(anchor, anchor);
          pending[1]({ ok: true, json: async () => ({ markdown: '![[second.png]]' }) });
          await new Promise(resolve => setTimeout(resolve, 0));
          const pathInput = document.querySelector('[name="path"]');
          pathInput.focus();
          pending[0]({ ok: true, json: async () => ({ markdown: '![[first.png]]' }) });
          await new Promise(resolve => setTimeout(resolve, 0));
          return { value: textarea.value, caret: textarea.selectionStart, focus: document.activeElement === pathInput };
        } finally { window.fetch = originalFetch; }
      }, PNG_BASE64);
      assert.match(result.value, /!\[正在保存图片…\]\(\)\n!\[\[first\.png\]\]abc!\[\[second\.png\]\]$/);
      assert.equal(result.caret, result.value.indexOf('abc') + 1);
      assert.equal(result.focus, true);
      await area().fill('# 草稿\n\n图片测试\n');
    });

    await check('图片上传期间阻止保存及离开，完成后替换占位符', async () => {
      const result = await area().evaluate(async (textarea, base64) => {
        const originalFetch = window.fetch;
        let complete, saves = 0;
        const form = textarea.form;
        window.fetch = (url, options) => {
          if (String(url) === '/api/attachments') return new Promise(resolve => { complete = resolve; });
          if (String(url) === form.action) {
            saves += 1;
            return Promise.resolve({ ok: false, status: 400, json: async () => ({ message: '不应提交' }) });
          }
          return originalFetch(url, options);
        };
        try {
          const transfer = new DataTransfer();
          transfer.items.add(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], 'pending.png', { type: 'image/png' }));
          textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
          const submit = new Event('submit', { bubbles: true, cancelable: true });
          form.dispatchEvent(submit);
          const leaving = new Event('beforeunload', { cancelable: true });
          window.dispatchEvent(leaving);
          const pending = textarea.value.includes('workstation-upload-');
          complete({ ok: true, json: async () => ({ markdown: '![[ready.png]]' }) });
          await new Promise(resolve => setTimeout(resolve, 0));
          return { saves, pending, blocked: submit.defaultPrevented, leaveBlocked: leaving.defaultPrevented,
            ready: textarea.value.includes('![[ready.png]]'), marker: textarea.value.includes('workstation-upload-') };
        } finally { window.fetch = originalFetch; }
      }, PNG_BASE64);
      assert.deepEqual(result, { saves: 0, pending: true, blocked: true, leaveBlocked: true, ready: true, marker: false });
      await area().fill('# 草稿\n\n图片测试\n');
    });

    await check('粘贴图片存进 attachments/ 并在光标处写入嵌入', async () => {
      await area().click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type('\n\n');
      await area().evaluate((textarea, base64) => {
        const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
        textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
      }, PNG_BASE64);
      await page.waitForFunction(() => /!\[\[\d{8}-\d{6}(-\d+)?\.png\]\]/.test(document.querySelector('textarea[data-md-editor]').value));
      const name = (await value()).match(/!\[\[(\d{8}-\d{6}(?:-\d+)?\.png)\]\]/)[1];
      assert.deepEqual(fsSync.readFileSync(path.join(vault, 'attachments', name)), Buffer.from(PNG_BASE64, 'base64'));
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
      await page.waitForURL('**/note/**');
      assert.equal(await page.locator('.prose img').evaluate(async image => { await image.decode(); return image.naturalWidth; }), 1);
    });

    await check('阅读页代码块有高亮和复制按钮，舒适行宽能切换', async () => {
      await visit('/note/inbox/' + encodeURIComponent('排队论读书笔记.md'));
      assert.ok(await page.locator('.prose pre .hljs-string').count() >= 1);
      assert.equal(await page.locator('.prose .code-copy').count(), 1);
      await page.locator('.note-more summary').click();
      await page.locator('.note-more-menu button', { hasText: '舒适行宽' }).click();
      await page.waitForSelector('.note-layout.is-comfort');
      await page.locator('.note-more summary').click();
      await page.locator('.note-more-menu button', { hasText: '正文铺满窗口' }).click();
      await page.waitForSelector('.note-layout:not(.is-comfort)');
    });

    await check('计划页一行添加待办', async () => {
      await visit('/plan?view=list');
      await page.locator('.plan-quick-add input[name=text]').fill('给导师发本周进展');
      await page.keyboard.press('Enter');
      await page.waitForURL('**/plan?**added=1**');
      assert.ok(await page.locator('.plan-list', { hasText: '给导师发本周进展' }).count() >= 1);
      const calendar = fsSync.readdirSync(path.join(vault, 'notes', 'calendar'));
      assert.equal(calendar.length, 1);
      assert.match(fsSync.readFileSync(path.join(vault, 'notes', 'calendar', calendar[0]), 'utf8'), /- \[ \] 给导师发本周进展 @\d{4}-\d{2}-\d{2}/);
    });

    await check('复习：挖空在原位显示答案，评分后按 Z 撤销', async () => {
      const lines = () => fsSync.existsSync(path.join(vault, 'reviews'))
        ? fsSync.readdirSync(path.join(vault, 'reviews')).flatMap(file => fsSync.readFileSync(path.join(vault, 'reviews', file), 'utf8').split('\n').filter(Boolean))
        : [];
      await visit('/review');
      assert.doesNotMatch(await page.locator('#review-front').textContent(), /ρ < 1/);
      await page.keyboard.press('Space');
      await page.waitForSelector('#review-front .cloze-answer');
      assert.equal(await page.locator('#review-front .cloze-answer').textContent(), 'ρ < 1');
      await page.keyboard.press('3');
      await page.waitForSelector('#review-done:not([hidden])');
      await page.waitForFunction(() => !document.getElementById('review-undo-last').hidden);
      assert.equal(lines().length, 1);
      await page.keyboard.press('z');
      await page.waitForSelector('#review-done[hidden]', { state: 'attached' });
      await page.waitForFunction(() => /稳定条件/.test(document.body.textContent) && !document.getElementById('review-reveal').hidden);
      const events = lines().map(JSON.parse);
      assert.equal(events.length, 2, '原评分与撤销记录均追加保留');
      assert.equal(events[1].type, 'undo');
      assert.equal(events[1].undo_event_id, events[0].event_id);
      assert.equal(await page.locator('#review-remaining').textContent(), '1');
    });

    await check('卡片正面预览渲染 Markdown 和公式，宽窄窗口均不溢出', async () => {
      await page.locator('#review-edit').click();
      await page.waitForSelector('#card-front');
      await page.locator('#card-front').fill('**稳定条件** $x<1$');
      await page.waitForSelector('.card-preview-front strong');
      await page.waitForSelector('.card-preview-front .katex');
      for (const width of [1440, 940]) {
        await page.setViewportSize({ width, height: 660 });
        const layout = await page.locator('.card-edit-form').evaluate(form => ({
          overflow: document.documentElement.scrollWidth > window.innerWidth,
          form: form.getBoundingClientRect().right > window.innerWidth
        }));
        assert.deepEqual(layout, { overflow: false, form: false });
      }
    });

    assert.deepEqual(errors, [], '页面没有抛出脚本错误');
  } finally {
    await close(app);
    if (!failed) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test('同步冲突：在设置窗口里逐个选边，解决后自动推送', { timeout: 120000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-conflict-desktop-'));
  const vault = path.join(root, 'vault');
  const other = path.join(root, 'other');
  const remote = path.join(root, 'remote.git');
  const userData = path.join(root, 'user');
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const identify = (dir, name) => { for (const [key, value] of [['user.name', name], ['user.email', `${name}@example.invalid`], ['core.autocrlf', 'false']]) git(dir, 'config', key, value); };
  let app;
  try {
    await fs.mkdir(path.join(vault, 'notes', 'inbox'), { recursive: true });
    await fs.writeFile(path.join(vault, 'notes', 'inbox', 'a.md'), '# 甲\n\n第一行\n第二行\n');
    await fs.writeFile(path.join(vault, 'notes', 'inbox', 'b.md'), '# 乙\n\n原文\n');
    // 应用自己会管这两个文件；先提交好，启动后的工作区才是干净的。
    const { VAULT_GITIGNORE, VAULT_GITATTRIBUTES } = require('../src/sync');
    await fs.writeFile(path.join(vault, '.gitignore'), VAULT_GITIGNORE);
    await fs.writeFile(path.join(vault, '.gitattributes'), VAULT_GITATTRIBUTES);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    execFileSync('git', ['init', '-q', '-b', 'main', vault]);
    identify(vault, 'laptop');
    git(vault, 'remote', 'add', 'origin', remote);
    git(vault, 'add', '-A'); git(vault, 'commit', '-q', '-m', 'init'); git(vault, 'push', '-q', '-u', 'origin', 'main');
    execFileSync('git', ['clone', '-q', remote, other]);
    identify(other, 'lab');
    await fs.writeFile(path.join(other, 'notes', 'inbox', 'a.md'), '# 甲\n\n第一行（实验室）\n第二行\n');
    await fs.writeFile(path.join(other, 'notes', 'inbox', 'b.md'), '# 乙\n\n实验室改的\n');
    git(other, 'commit', '-q', '-am', 'lab'); git(other, 'push', '-q');
    await fs.writeFile(path.join(vault, 'notes', 'inbox', 'a.md'), '# 甲\n\n第一行（笔记本）\n第二行\n');
    await fs.writeFile(path.join(vault, 'notes', 'inbox', 'b.md'), '# 乙\n\n笔记本改的\n');
    git(vault, 'commit', '-q', '-am', 'laptop');

    await writeSettings(userData, { vaultDir: vault, device: 'conflict-smoke', syncEnabled: true });
    const launched = await launch(userData);
    app = launched.app;
    const { page, origin } = launched;

    // 启动时的后台拉取就会撞上冲突。
    // rebase 标记先于冲突索引出现；等同步操作已停在实际冲突上再检查。
    await page.waitForFunction(async () => {
      const report = await fetch('/api/health').then(response => response.json());
      return report.recovery.syncRecovery?.kind === 'rebase' && report.recovery.syncRecovery.unmergedCount >= 2;
    }, null, { timeout: 30000 });
    assert.match(git(vault, 'status', '--porcelain'), /^UU /m);

    await app.evaluate(({ Menu }) => {
      const find = items => { for (const item of items) { if (item.id === 'show-settings') return item; const found = item.submenu && find(item.submenu.items); if (found) return found; } return null; };
      find(Menu.getApplicationMenu().items).click();
    });
    let settings;
    for (let attempt = 0; attempt < 50 && !settings; attempt += 1) {
      settings = app.windows().find(window => window.url().includes('/settings/'));
      if (!settings) await page.waitForTimeout(100);
    }
    assert.ok(settings, '设置窗口已打开');
    settings.setDefaultTimeout(8000);
    await settings.waitForSelector('#conflict-panel:not([hidden]) .conflict-file');
    assert.equal(await settings.locator('.conflict-file').count(), 2);
    assert.match(await settings.locator('#sync-status-title').textContent(), /冲突/);
    assert.equal(await settings.locator('#resolve-conflicts').isDisabled(), true);
    assert.match(await settings.locator('#conflict-progress').textContent(), /还有 2 个文件没选/);

    // 看得到两边差在哪里。
    await settings.locator('.conflict-diff summary').first().click();
    assert.match(await settings.locator('.conflict-diff-body').first().textContent(), /第一行（实验室）/);
    assert.match(await settings.locator('.conflict-diff-body').first().textContent(), /第一行（笔记本）/);

    await settings.locator('#conflict-all-local').click();
    await settings.locator('.conflict-file').first().locator('input[value=remote]').check();
    assert.equal(await settings.locator('#resolve-conflicts').isDisabled(), false);
    await settings.locator('#resolve-conflicts').click();
    await settings.waitForFunction(() => /冲突已解决/.test(document.getElementById('message').textContent), null, { timeout: 20000 });
    await settings.waitForSelector('#conflict-panel[hidden]', { state: 'attached' });

    assert.equal(fsSync.readFileSync(path.join(vault, 'notes', 'inbox', 'a.md'), 'utf8'), '# 甲\n\n第一行（实验室）\n第二行\n');
    assert.equal(fsSync.readFileSync(path.join(vault, 'notes', 'inbox', 'b.md'), 'utf8'), '# 乙\n\n笔记本改的\n');
    assert.equal(git(vault, 'status', '--porcelain'), '');
    // 解决后后台自动同步一轮，把结果推上去。
    await page.waitForFunction(() => true);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (git(vault, 'rev-list', '--left-right', '--count', 'HEAD...@{u}').trim() === '0\t0' && git(remote, 'log', '-1', '--format=%s', 'main').trim() !== 'lab') break;
      await page.waitForTimeout(200);
    }
    assert.equal(git(vault, 'rev-list', '--left-right', '--count', 'HEAD...@{u}').trim(), '0\t0');
    assert.equal(git(remote, 'show', 'main:notes/inbox/b.md'), '# 乙\n\n笔记本改的\n');

    // 没采用的那一边能在历史页找回，并且看得到和现在差在哪里。
    await page.goto(origin + '/history');
    assert.equal(await page.locator('.history-kind.is-kept', { hasText: '冲突未采用' }).count(), 2);
    await page.locator('.history-list a', { hasText: '甲' }).first().click();
    await page.waitForSelector('.history-diff');
    assert.match(await page.locator('.history-diff .diff-row.is-del').first().textContent(), /第一行（笔记本）/);
    // 正文里的索引也跟上了。
    await page.goto(origin + '/note/inbox/a.md');
    assert.match(await page.locator('.prose').textContent(), /第一行（实验室）/);
  } finally {
    await close(app);
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
