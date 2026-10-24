const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { renderLiteratureNote } = require('../src/annotations');
const { createPlatformPolicy } = require('../electron/platform-policy');

// 平台差异一律问 platform-policy，不要在这里重写一遍 `platform === 'darwin'`。
// 登录启动和自动更新只有 Windows 有，所以「非 macOS 即 Windows」是错的 ——
// 开发和 CI 都在 Linux 上跑，那边和 macOS 一样两项都没有。
// 各平台各自该得到什么由 desktop-platform-policy.test.js 钉住。
const { capabilities: platformCapabilities, restoreOnActivate } = createPlatformPolicy();

let electron;
try {
  ({ _electron: electron } = require('playwright-core'));
} catch {}

const projectDir = path.resolve(__dirname, '..');
const packagedExecutable = process.env.WORKSTATION_EXECUTABLE || '';

function monitorRenderer(page, errors) {
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`${page.url()}：${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`${page.url()}：${error.message}`));
}

function consumeExpectedRendererError(errors, pattern) {
  const matches = errors.filter(error => pattern.test(error));
  assert.equal(matches.length, 1, `预期一条 renderer 错误 ${pattern}，实际：${errors.join('\n')}`);
  errors.splice(errors.indexOf(matches[0]), 1);
}

test('Electron 主窗口、设置重启、托盘和退出流程', {
  skip: !electron && '尚未安装桌面测试依赖',
  timeout: 90_000
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-electron-'));
  const userDataDir = path.join(root, 'user-data');
  const vaultDir = path.join(root, 'vault');
  const emptyVaultDir = path.join(root, 'empty-vault');
  const settingsDir = path.join(userDataDir, 'workstation-data');
  const settingsPath = path.join(settingsDir, 'settings.json');
  const rendererErrors = [];
  let electronApp;

  try {
    await Promise.all([
      fs.mkdir(path.join(vaultDir, 'notes', 'experiments'), { recursive: true }),
      fs.mkdir(path.join(vaultDir, 'notes', 'lit'), { recursive: true }),
      fs.mkdir(path.join(vaultDir, 'cards'), { recursive: true }),
      fs.mkdir(path.join(vaultDir, 'reviews'), { recursive: true }),
      fs.mkdir(path.join(vaultDir, 'attachments'), { recursive: true }),
      fs.mkdir(path.join(emptyVaultDir, 'notes'), { recursive: true }),
      fs.mkdir(settingsDir, { recursive: true })
    ]);
    await fs.writeFile(path.join(vaultDir, 'notes', 'experiments', 'smoke.md'), `---
title: Smoke 实验
status: running
dataset: desktop-fixture
---

真实 Electron 看板测试。
`, 'utf8');
    await fs.writeFile(path.join(vaultDir, 'notes', 'lit', 'SMOKE123.md'), renderLiteratureNote({
      item: { key: 'SMOKE123', title: 'Smoke 文献', creators: [], tags: [] },
      annotations: [{ itemID: 10, text: '真实 Electron 标注', comment: '加工这条标注', page: '12', sortIndex: '0001' }]
    }), 'utf8');
    await fs.writeFile(path.join(vaultDir, 'cards', 'smoke.md'), [
      '---',
      'deck: 桌面冒烟',
      '---',
      '',
      '## Electron 正面',
      'Electron 背面'
    ].join('\n'), 'utf8');
    await fs.writeFile(settingsPath, `${JSON.stringify({
      schemaVersion: 1,
      vaultDir,
      device: 'desktop-smoke',
      syncEnabled: false,
      syncIntervalMinutes: 15,
      launchAtLogin: false,
      blobServerUrl: 'http://100.64.0.2:4100',
      secrets: {}
    }, null, 2)}\n`, 'utf8');

    const launchEnvironment = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
    delete launchEnvironment.ELECTRON_RUN_AS_NODE;
    const userDataArgument = `--workstation-user-data=${userDataDir}`;
    const launchOptions = packagedExecutable
      ? {
          executablePath: path.resolve(packagedExecutable),
          args: ['--workstation-smoke-test', userDataArgument],
          env: launchEnvironment
        }
      : {
          args: [projectDir, userDataArgument],
          env: launchEnvironment
        };

    electronApp = await electron.launch(launchOptions);

    const mainPage = await electronApp.firstWindow();
    monitorRenderer(mainPage, rendererErrors);
    const actualUserDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'));
    assert.equal(path.resolve(actualUserDataDir), path.resolve(userDataDir));
    await mainPage.waitForLoadState('domcontentloaded');
    assert.match(await mainPage.title(), /科研工作台/);
    await mainPage.waitForSelector('.workspace-sidebar');
    assert.equal(await mainPage.locator('.workspace-sidebar .workspace-nav-link[aria-current="page"]').innerText(), '今日');
    assert.equal(await mainPage.locator('#main-content').count(), 1);
    assert.equal(await mainPage.locator('.topsearch input').getAttribute('aria-label'), '搜索笔记');

    const mainWindow = await electronApp.browserWindow(mainPage);
    const initialSize = await mainWindow.evaluate(window => window.getSize());
    assert.ok(initialSize[0] >= 900 && initialSize[0] <= 1280, `初始宽度 ${initialSize[0]}`);
    assert.ok(initialSize[1] >= 620 && initialSize[1] <= 840, `初始高度 ${initialSize[1]}`);
    assert.deepEqual(await mainWindow.evaluate(window => window.getMinimumSize()), [900, 620]);
    for (const size of [[1280, 840], [1024, 700], [900, 620]]) {
      await mainWindow.evaluate((window, [width, height]) => window.setSize(width, height), size);
      await mainPage.waitForTimeout(100);
      const layout = await mainPage.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        sidebarWidth: Math.round(document.querySelector('.workspace-sidebar').getBoundingClientRect().width),
        navVisible: getComputedStyle(document.querySelector('.workspace-sidebar .workspace-nav')).display !== 'none'
      }));
      assert.ok(layout.scrollWidth <= layout.clientWidth, `${size.join('×')} ${JSON.stringify(layout)}`);
      assert.ok(layout.sidebarWidth >= 180, `${size.join('×')} ${JSON.stringify(layout)}`);
      assert.equal(layout.navVisible, true);
    }

    for (const zoomFactor of [1.25, 1.5]) {
      await mainWindow.evaluate((window, zoom) => window.webContents.setZoomFactor(zoom), zoomFactor);
      await mainPage.waitForTimeout(100);
      const zoomLayout = await mainPage.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        mainVisible: document.getElementById('main-content').getBoundingClientRect().width > 0
      }));
      assert.ok(zoomLayout.scrollWidth <= zoomLayout.clientWidth, `${zoomFactor} ${JSON.stringify(zoomLayout)}`);
      assert.equal(zoomLayout.mainVisible, true);
    }
    const compactLayout = await mainPage.evaluate(() => ({
      height: innerHeight,
      titleBottom: document.querySelector('main h1').getBoundingClientRect().bottom,
      navigationHeight: document.querySelector('.workspace-sidebar').getBoundingClientRect().height
    }));
    assert.ok(compactLayout.navigationHeight < 90, JSON.stringify(compactLayout));
    assert.ok(compactLayout.titleBottom < compactLayout.height, JSON.stringify(compactLayout));
    await mainPage.locator('[data-navigation-open]').click();
    await mainPage.locator('#navigation-dialog[open]').waitFor();
    assert.equal(await mainPage.locator('[data-navigation-open]').getAttribute('aria-expanded'), 'true');
    assert.equal(await mainPage.locator('#navigation-dialog .workspace-nav-link[aria-current="page"]').evaluate(link => link === document.activeElement), true);
    await mainPage.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    assert.equal(await mainPage.locator('#palette').evaluate(dialog => dialog.open), false);
    await mainPage.keyboard.press('Escape');
    await mainPage.waitForFunction(() => !document.getElementById('navigation-dialog').open);
    assert.equal(await mainPage.locator('[data-navigation-open]').evaluate(button => button === document.activeElement), true);
    await mainPage.locator('[data-navigation-open]').click();
    await mainWindow.evaluate(window => window.webContents.setZoomFactor(1));
    await mainPage.waitForFunction(() => !document.getElementById('navigation-dialog').open);

    await mainPage.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    const darkPreferences = await mainPage.evaluate(() => ({
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      canvas: getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim(),
      transitionSeconds: Number.parseFloat(getComputedStyle(document.querySelector('.workspace-nav-link')).transitionDuration)
    }));
    assert.equal(darkPreferences.dark, true);
    assert.equal(darkPreferences.reduced, true);
    assert.equal(darkPreferences.canvas, '#191a17');
    assert.ok(darkPreferences.transitionSeconds <= 0.00001, JSON.stringify(darkPreferences));
    await mainPage.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    assert.equal(await mainPage.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim()), '#f4f1ea');

    await mainPage.reload();
    await mainPage.waitForSelector('.workspace-sidebar');
    await mainPage.focus('body');
    await mainPage.keyboard.press('Tab');
    assert.equal(await mainPage.evaluate(() => document.activeElement?.classList.contains('skip-link')), true);
    await mainPage.keyboard.press('Enter');
    assert.equal(await mainPage.evaluate(() => document.activeElement?.id), 'main-content');
    await mainPage.keyboard.press('Shift+Tab');
    assert.equal(await mainPage.evaluate(() => document.activeElement?.matches('.toolbar-command')), true);
    const keyboardFocus = await mainPage.evaluate(() => {
      const style = getComputedStyle(document.activeElement);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    assert.notEqual(keyboardFocus.outlineStyle, 'none');
    assert.notEqual(keyboardFocus.outlineWidth, '0px');
    await mainPage.keyboard.press('Shift+Tab');
    assert.equal(await mainPage.evaluate(() => document.activeElement?.matches('.topsearch input')), true);
    await mainPage.keyboard.press('Shift+Tab');
    assert.equal(await mainPage.evaluate(() => document.activeElement?.matches('.sidebar-command')), true);

    await mainPage.locator('#main-content').focus();
    await mainPage.keyboard.press('/');
    assert.equal(await mainPage.evaluate(() => document.activeElement?.matches('.topsearch input')), true);

    await mainPage.locator('[data-palette-open]').first().focus();
    await mainPage.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    await mainPage.locator('#palette[open]').waitFor();
    assert.equal(await mainPage.evaluate(() => document.activeElement?.classList.contains('palette-input')), true);
    await mainPage.locator('.palette-list [role="option"]').first().waitFor();
    const activeDescendant = await mainPage.locator('.palette-input').getAttribute('aria-activedescendant');
    assert.match(activeDescendant, /^palette-option-\d+$/);
    assert.equal(await mainPage.locator(`#${activeDescendant}`).getAttribute('aria-selected'), 'true');
    await mainPage.keyboard.press('Escape');
    await mainPage.waitForFunction(() => !document.getElementById('palette').open);
    assert.equal(await mainPage.evaluate(() => document.activeElement?.hasAttribute('data-palette-open')), true);

    await mainPage.goto(`${new URL(mainPage.url()).origin}/new?path=smoke/editor`);
    await mainPage.waitForSelector('[data-editor-form]');
    await mainPage.fill('[name="body"]', '真实 Electron 编辑器内容');
    assert.equal(await mainPage.locator('[data-editor-status]').innerText(), '有未保存的更改');
    await mainPage.click('[data-editor-save]');
    await mainPage.waitForURL('**/note/smoke/editor.md');
    assert.match(await mainPage.locator('.prose').innerText(), /真实 Electron 编辑器内容/);
    await mainPage.locator('#main-content').focus();
    const selectedText = await mainPage.evaluate(() => {
      const prose = document.querySelector('.prose');
      const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
      const textNode = walker.nextNode();
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return selection.toString().trim();
    });
    assert.ok(selectedText);
    await mainPage.locator('.selection-card button').click();
    await mainPage.locator('.selection-form[open]').waitFor();
    assert.equal(await mainPage.locator('.selection-form [name="front"]').inputValue(), selectedText);
    assert.equal(await mainPage.evaluate(() => document.activeElement?.name), 'front');
    await mainPage.keyboard.press('Escape');
    await mainPage.waitForFunction(() => !document.querySelector('.selection-form'));
    assert.equal(await mainPage.evaluate(() => document.activeElement?.id), 'main-content');

    await mainPage.goto(`${new URL(mainPage.url()).origin}/edit/smoke/editor.md`);
    await mainPage.waitForSelector('[data-editor-form]');
    await mainPage.fill('[name="body"]', '原有同名文字：![上传中 same.png…]()\n');
    await mainPage.locator('[name="body"]').evaluate(textarea => {
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    });

    const attachmentRoute = /\/attachments\?name=/;
    const attachmentGates = new Map();
    let resolveAttachmentRequests;
    const attachmentRequests = new Promise(resolve => { resolveAttachmentRequests = resolve; });
    await mainPage.route(attachmentRoute, async route => {
      const marker = route.request().postDataBuffer().toString('utf8');
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      attachmentGates.set(marker, release);
      if (attachmentGates.size === 2) resolveAttachmentRequests();
      await gate;
      await fs.writeFile(path.join(vaultDir, 'attachments', `${marker}.png`), marker, 'utf8');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, url: `/attachments/${marker}.png` })
      });
    });

    await mainPage.locator('[name="body"]').evaluate(textarea => {
      const drop = marker => {
        const event = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', {
          value: {
            files: [new File([marker], 'same.png', { type: 'image/png' })],
            types: ['Files']
          }
        });
        textarea.dispatchEvent(event);
      };
      drop('first');
      drop('second');
    });
    await attachmentRequests;
    await mainPage.waitForFunction(() => (
      document.querySelector('[name="body"]').value.match(/workstation-attachment-upload:/g) || []
    ).length === 2);

    attachmentGates.get('second')();
    await mainPage.waitForFunction(() => document.querySelector('[name="body"]').value.includes('/attachments/second.png'));
    await mainPage.locator('[name="body"]').evaluate(textarea => {
      textarea.value = textarea.value.replace(
        /!\[上传中 same\.png…\]\(\)(<!-- workstation-attachment-upload:[^>]+ -->)/,
        '![用户改过占位]()$1'
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    attachmentGates.get('first')();
    await mainPage.waitForFunction(() => [...document.querySelectorAll('.toast.is-error')]
      .some(toast => toast.textContent.includes('占位内容已被修改或删除')));

    const attachmentText = await mainPage.locator('[name="body"]').inputValue();
    assert.match(attachmentText, /原有同名文字：!\[上传中 same\.png…\]\(\)/);
    assert.match(attachmentText, /!\[same\.png\]\(\/attachments\/second\.png\)/);
    assert.match(attachmentText, /!\[用户改过占位\]\(\)/);
    assert.ok(!attachmentText.includes('/attachments/first.png'));
    await mainPage.unroute(attachmentRoute);

    await mainPage.fill('[name="body"]', '真实 Electron 编辑器内容\n\n![same.png](/attachments/second.png)');
    await mainPage.click('[data-editor-save]');
    await mainPage.waitForURL('**/note/smoke/editor.md');

    const editorPath = path.join(vaultDir, 'notes', 'smoke', 'editor.md');
    await fs.writeFile(editorPath, '删除前的外部版本\n', 'utf8');
    mainPage.once('dialog', dialog => dialog.accept());
    const deleteResponsePromise = mainPage.waitForResponse(response => (
      new URL(response.url()).pathname === '/delete'
      && response.request().method() === 'POST'
    ));
    await mainPage.locator('.note-more summary').click();
    await mainPage.locator('[data-confirm-delete] button').click();
    const deleteResponse = await deleteResponsePromise;
    assert.equal(deleteResponse.status(), 409);
    assert.equal(await fs.readFile(editorPath, 'utf8'), '删除前的外部版本\n');

    await mainPage.goto(`${new URL(mainPage.url()).origin}/edit/smoke/editor.md`);
    await mainPage.waitForSelector('[data-editor-form]');
    await fs.writeFile(editorPath, '保存前的外部版本\n', 'utf8');
    await mainPage.fill('[name="body"]', '不应覆盖外部版本的旧草稿');
    await mainPage.click('[data-editor-save]');
    await mainPage.waitForFunction(() => document.querySelector('[data-editor-status]').textContent.includes('笔记已被其它操作修改'));
    assert.equal(await mainPage.locator('[name="body"]').inputValue(), '不应覆盖外部版本的旧草稿');
    assert.equal(await fs.readFile(editorPath, 'utf8'), '保存前的外部版本\n');

    await mainPage.fill('[name="body"]', '删除前的外部版本\n');
    await mainPage.goto(`${new URL(mainPage.url()).origin}/library`);
    await mainPage.waitForSelector('[data-literature-item][data-key="SMOKE123"]');
    assert.match(await mainPage.locator('[data-pending-count]').innerText(), /1 条待加工/);
    await mainPage.locator('[data-process-annotation]').click();
    await mainPage.locator('[data-annotation-dialog][open]').waitFor();
    assert.equal(await mainPage.locator('[data-annotation-source]').innerText(), '真实 Electron 标注');
    assert.equal(await mainPage.locator('[name="noteTitle"]').inputValue(), '加工这条标注');
    assert.equal(await mainPage.evaluate(() => document.activeElement?.dataset.outputToggle), 'note');
    await mainPage.locator('[data-dialog-submit]').click();
    await mainPage.waitForFunction(() => !document.querySelector('[data-annotation-dialog]').open);
    assert.equal(await mainPage.locator('[data-process-annotation]').count(), 0);
    assert.match(await mainPage.locator('[data-pending-count]').innerText(), /0 条待加工/);
    await mainPage.goto(`${new URL(mainPage.url()).origin}/`);
    assert.equal(await mainPage.locator('a[href="/library"] .stat-value').innerText(), '0条');

    const graphWorkerRequest = mainPage.waitForRequest(request => (
      new URL(request.url()).pathname === '/static/graph-worker.js'
    ));
    await mainPage.goto(`${new URL(mainPage.url()).origin}/graph`);
    await graphWorkerRequest;
    await mainPage.waitForSelector('.graph-svg .graph-node-link');
    await mainPage.waitForFunction(() => {
      const box = document.getElementById('graph');
      const data = JSON.parse(decodeURIComponent(box.dataset.graph));
      const width = box.clientWidth || 900;
      return [...document.querySelectorAll('.graph-node')].some((circle, index) => {
        const angle = (index / data.nodes.length) * Math.PI * 2;
        const initialX = width / 2 + Math.cos(angle) * width * 0.3;
        const initialY = 230 + Math.sin(angle) * 460 * 0.35;
        return Math.abs(Number(circle.getAttribute('cx')) - initialX) > 0.01
          || Math.abs(Number(circle.getAttribute('cy')) - initialY) > 0.01;
      });
    });
    assert.match(await mainPage.locator('.graph-node-link').first().getAttribute('href'), /^\/note\//);

    await mainPage.goto(`${new URL(mainPage.url()).origin}/calendar?month=2026-08&day=2026-08-18`);
    await mainPage.waitForSelector('[data-plan-form]');
    await mainPage.fill('[data-plan-form] [name="from"]', '09:00');
    await mainPage.fill('[data-plan-form] [name="to"]', '10:00');
    await mainPage.fill('[data-plan-form] [name="what"]', '真实 Electron 排期');
    await mainPage.click('[data-plan-form] button[type="submit"]');
    await mainPage.waitForFunction(() => [...document.querySelectorAll('[data-plan-list] li')]
      .some(item => item.textContent.includes('真实 Electron 排期')));
    assert.match(
      await mainPage.locator('.calday[href*="day=2026-08-18"] .calpill.is-plan').innerText(),
      /09:00.*真实 Electron 排期/
    );

    assert.equal(await mainPage.locator('[data-plan-total]').innerText(), '1');
    assert.match(await mainPage.locator('.calday[data-date="2026-08-18"]').getAttribute('aria-label'), /1 个时间块/);
    assert.equal(await mainPage.locator('.calday[data-date="2026-08-18"] .calday-diary').count(), 1);

    const diaryPath = path.join(vaultDir, 'notes', 'diary', '2026-08-18.md');
    const diaryAfterPlan = await fs.readFile(diaryPath, 'utf8');
    const externallyEditedDiary = `${diaryAfterPlan}\n外部编辑保留这一行。\n`;
    await fs.writeFile(diaryPath, externallyEditedDiary, 'utf8');
    await mainPage.fill('[data-plan-form] [name="what"]', '不应落盘的旧排期');
    await mainPage.click('[data-plan-form] button[type="submit"]');
    await mainPage.waitForFunction(() => [...document.querySelectorAll('.toast.is-error')]
      .some(toast => toast.textContent.includes('已在别处修改')));
    assert.equal(await mainPage.locator('[data-plan-form] [name="what"]').inputValue(), '不应落盘的旧排期');
    assert.equal(await fs.readFile(diaryPath, 'utf8'), externallyEditedDiary);

    await mainPage.goto(`${new URL(mainPage.url()).origin}/board/experiment`);
    await mainPage.waitForSelector('[data-board-card][data-path="experiments/smoke.md"]');
    const experimentCard = mainPage.locator('[data-board-card][data-path="experiments/smoke.md"]');
    await experimentCard.locator('[name="status"]').selectOption('done');
    await mainPage.locator('[data-board-column][data-status="done"] [data-board-card][data-path="experiments/smoke.md"]').waitFor();
    assert.equal(await experimentCard.getAttribute('data-status'), 'done');
    assert.equal(await mainPage.locator('[data-board-column][data-status="running"] [data-column-count]').innerText(), '0');
    assert.equal(await mainPage.locator('[data-board-column][data-status="done"] [data-column-count]').innerText(), '1');

    const experimentPath = path.join(vaultDir, 'notes', 'experiments', 'smoke.md');
    const experimentAfterStatus = await fs.readFile(experimentPath, 'utf8');
    const externallyEditedExperiment = `${experimentAfterStatus}\n外部实验记录。\n`;
    await fs.writeFile(experimentPath, externallyEditedExperiment, 'utf8');
    await experimentCard.locator('[name="status"]').selectOption('running');
    await mainPage.waitForFunction(() => [...document.querySelectorAll('.toast.is-error')]
      .some(toast => toast.textContent.includes('卡片没有移动')));
    assert.equal(await experimentCard.getAttribute('data-status'), 'done');
    assert.equal(await experimentCard.locator('[name="status"]').inputValue(), 'done');
    assert.equal(await fs.readFile(experimentPath, 'utf8'), externallyEditedExperiment);

    await mainPage.goto(`${new URL(mainPage.url()).origin}/review`);
    await mainPage.waitForSelector('#reviewer');
    await mainPage.click('#review-reveal');
    await mainPage.click('[data-rating="3"]');
    await mainPage.waitForFunction(() => !document.getElementById('review-done').hidden);
    assert.match(await mainPage.locator('#review-summary').innerText(), /复习了 1 张/);
    assert.match(await mainPage.locator('#review-summary').innerText(), /同步未启用/);
    const reviewFiles = await fs.readdir(path.join(vaultDir, 'reviews'));
    assert.deepEqual(reviewFiles, [`${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-desktop-smoke.jsonl`]);
    const reviewEvents = (await fs.readFile(path.join(vaultDir, 'reviews', reviewFiles[0]), 'utf8'))
      .trim().split('\n').map(JSON.parse);
    assert.equal(reviewEvents.length, 1);
    assert.match(reviewEvents[0].event_id, /^[0-9a-f-]{36}$/);
    assert.equal(reviewEvents[0].card_id, 'smoke/Electron 正面');
    assert.equal(reviewEvents[0].rating, 3);

    const origin = new URL(mainPage.url()).origin;
    const denied = await fetch(origin);
    assert.equal(denied.status, 403);

    const platformMenu = await electronApp.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      const settings = menu.getMenuItemById('show-settings');
      const quit = menu.getMenuItemById('quit-application');
      const login = menu.getMenuItemById('launch-at-login');
      return {
        settingsAccelerator: settings.accelerator,
        quitAccelerator: quit.accelerator,
        hasWindowMenu: Boolean(menu.getMenuItemById('window-menu')),
        hasLoginItem: Boolean(login)
      };
    });
    // 菜单形状（应用菜单角色、Command 快捷键、窗口菜单）是 macOS 独有的；
    // 登录启动项跟的是能力开关，两者不是同一个条件，分开断言。
    if (process.platform === 'darwin') {
      assert.equal(platformMenu.settingsAccelerator, 'Command+,');
      assert.equal(platformMenu.quitAccelerator, 'Command+Q');
      assert.equal(platformMenu.hasWindowMenu, true);
    }
    assert.equal(platformMenu.hasLoginItem, platformCapabilities.launchAtLogin);

    const settingsPagePromise = electronApp.waitForEvent('window');
    await electronApp.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('show-settings').click());
    const settingsPage = await settingsPagePromise;
    monitorRenderer(settingsPage, rendererErrors);
    await settingsPage.waitForSelector('#settings-form');
    await settingsPage.evaluate(() => { window.location.hash = 'sync'; });
    await settingsPage.waitForFunction(() => document.getElementById('runtime-status').textContent === '工作台运行中');
    assert.equal(await settingsPage.locator('body').getAttribute('data-settings-state'), 'clean');
    assert.equal(await settingsPage.locator('#settings-state').innerText(), '已同步');
    assert.match(
      await settingsPage.locator('[name="device"] + small').innerText(),
      /短摘要.*避免不同设备重名/
    );
    assert.equal(await settingsPage.locator('#save').isDisabled(), true);
    // settings.css 里 `html { scroll-behavior: smooth }`，改 hash 触发的是一次动画滚动。
    // 滚动途中每一帧都会触发 activateVisibleSection 按当前位置重算高亮 —— 这是对的，
    // 但意味着动画没走完时读到的是中间帧（页面还在顶上，高亮在「工作区」）。
    // 所以要等三件事同时成立：滚动真的到了 #sync、连续几帧不再移动、高亮落在 #sync。
    // 只等其中一件都会在机器忙的时候随机读到中间状态。
    await settingsPage.waitForFunction(
      () => {
        const state = window.__smokeScroll ||= { last: null, stable: 0 };
        state.stable = state.last === window.scrollY ? state.stable + 1 : 0;
        state.last = window.scrollY;
        return state.stable >= 3
          && document.getElementById('sync').getBoundingClientRect().top <= 24
          && document.querySelector('[data-settings-nav] a[href="#sync"]')?.getAttribute('aria-current') === 'location';
      },
      undefined,
      { timeout: 5_000, polling: 'raf' }
    );
    await settingsPage.evaluate(() => { delete window.__smokeScroll; });
    assert.equal(await settingsPage.locator('[data-settings-nav] a[href="#sync"]').getAttribute('aria-current'), 'location');

    const settingsWindow = await electronApp.browserWindow(settingsPage);
    assert.deepEqual(await settingsWindow.evaluate(window => window.getMinimumSize()), [760, 620]);
    await settingsWindow.evaluate(window => window.setSize(760, 620));
    await settingsPage.waitForTimeout(100);
    const settingsLayout = await settingsPage.evaluate(() => {
      const form = document.getElementById('settings-form').getBoundingClientRect();
      const saveBar = document.querySelector('.save-bar').getBoundingClientRect();
      return {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        formRight: Math.round(form.right),
        saveBarRight: Math.round(saveBar.right),
        saveVisible: saveBar.bottom <= window.innerHeight + 1
      };
    });
    assert.ok(settingsLayout.scrollWidth <= settingsLayout.clientWidth, JSON.stringify(settingsLayout));
    assert.ok(settingsLayout.formRight <= settingsLayout.clientWidth, JSON.stringify(settingsLayout));
    assert.ok(settingsLayout.saveBarRight <= settingsLayout.clientWidth, JSON.stringify(settingsLayout));
    assert.equal(settingsLayout.saveVisible, true);
    // 同样是平滑滚动：不等它到底就量，测到的是动画途中的位置。
    await settingsPage.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await settingsPage.waitForFunction(
      () => {
        const state = window.__smokeScroll ||= { last: null, stable: 0 };
        state.stable = state.last === window.scrollY ? state.stable + 1 : 0;
        state.last = window.scrollY;
        const atBottom = Math.abs(window.scrollY + window.innerHeight - document.documentElement.scrollHeight) <= 2;
        return state.stable >= 3 && atBottom;
      },
      undefined,
      { timeout: 5_000, polling: 'raf' }
    );
    await settingsPage.evaluate(() => { delete window.__smokeScroll; });
    const bottomClearance = await settingsPage.evaluate(() => ({
      sectionBottom: Math.round(document.getElementById('system').getBoundingClientRect().bottom),
      saveBarTop: Math.round(document.querySelector('.save-bar').getBoundingClientRect().top)
    }));
    assert.ok(bottomClearance.sectionBottom <= bottomClearance.saveBarTop, JSON.stringify(bottomClearance));
    for (const zoomFactor of [1.25, 1.5]) {
      await settingsWindow.evaluate((window, zoom) => window.webContents.setZoomFactor(zoom), zoomFactor);
      await settingsPage.waitForTimeout(100);
      const zoomLayout = await settingsPage.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        saveBarRight: Math.round(document.querySelector('.save-bar').getBoundingClientRect().right)
      }));
      assert.ok(zoomLayout.scrollWidth <= zoomLayout.clientWidth, `${zoomFactor} ${JSON.stringify(zoomLayout)}`);
      assert.ok(zoomLayout.saveBarRight <= zoomLayout.clientWidth + 1, `${zoomFactor} ${JSON.stringify(zoomLayout)}`);
    }
    await settingsWindow.evaluate(window => window.webContents.setZoomFactor(1));

    const recoveryPagePromise = electronApp.waitForEvent('window');
    await settingsPage.click('#open-recovery');
    const recoveryPage = await recoveryPagePromise;
    monitorRenderer(recoveryPage, rendererErrors);
    await recoveryPage.waitForSelector('#recovery-form');
    await recoveryPage.waitForFunction(() => document.body.dataset.phase === 'idle');
    assert.equal(await recoveryPage.locator('#first-run').isHidden(), true);
    assert.equal(await recoveryPage.locator('#source-panel').isVisible(), true);
    assert.equal(await recoveryPage.locator('#destination-panel').isVisible(), true);
    assert.equal(await settingsPage.locator('body').getAttribute('data-settings-state'), 'clean');

    const recoveryWindow = await electronApp.browserWindow(recoveryPage);
    assert.deepEqual(await recoveryWindow.evaluate(window => window.getMinimumSize()), [900, 620]);
    const recoverySecurity = await recoveryWindow.evaluate(window => {
      const preferences = window.webContents.getLastWebPreferences();
      return {
        nodeIntegration: preferences.nodeIntegration,
        contextIsolation: preferences.contextIsolation,
        sandbox: preferences.sandbox
      };
    });
    assert.deepEqual(recoverySecurity, {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    });
    assert.deepEqual(await recoveryPage.evaluate(() => ({
      requireType: typeof window.require,
      processType: typeof window.process,
      api: Object.keys(window.workstationRecovery).sort()
    })), {
      requireType: 'undefined',
      processType: 'undefined',
      api: [
        'activate', 'beginRestore', 'cancel', 'chooseDestinationParent',
        'chooseLocalSource', 'createVault', 'discardOwnedStaging', 'getState',
        'inspectRemote', 'onStateChanged', 'openCurrentVault', 'openExistingVault',
        'retryStage', 'start'
      ]
    });

    await recoveryWindow.evaluate(window => window.setSize(900, 620));
    for (const zoomFactor of [1, 1.25, 1.5]) {
      await recoveryWindow.evaluate((window, zoom) => window.webContents.setZoomFactor(zoom), zoomFactor);
      await recoveryPage.waitForTimeout(100);
      const layout = await recoveryPage.evaluate(() => {
        const footer = document.querySelector('.actions').getBoundingClientRect();
        const start = document.getElementById('start').getBoundingClientRect();
        return {
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          footerRight: Math.round(footer.right),
          footerBottom: Math.round(footer.bottom),
          startRight: Math.round(start.right),
          startBottom: Math.round(start.bottom)
        };
      });
      assert.ok(layout.scrollWidth <= layout.clientWidth, `${zoomFactor} ${JSON.stringify(layout)}`);
      assert.ok(layout.footerRight <= layout.clientWidth + 1, `${zoomFactor} ${JSON.stringify(layout)}`);
      assert.ok(layout.footerBottom <= 620 / zoomFactor + 1, `${zoomFactor} ${JSON.stringify(layout)}`);
      assert.ok(layout.startRight <= layout.clientWidth + 1, `${zoomFactor} ${JSON.stringify(layout)}`);
      assert.ok(layout.startBottom <= 620 / zoomFactor + 1, `${zoomFactor} ${JSON.stringify(layout)}`);
    }
    await recoveryWindow.evaluate(window => window.webContents.setZoomFactor(1));
    await recoveryPage.focus('body');
    await recoveryPage.keyboard.press('Tab');
    assert.equal(await recoveryPage.evaluate(() => document.activeElement?.name), 'sourceKind');
    const recoveryFocus = await recoveryPage.evaluate(() => {
      const style = getComputedStyle(document.activeElement);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    assert.notEqual(recoveryFocus.outlineStyle, 'none');
    assert.notEqual(recoveryFocus.outlineWidth, '0px');
    assert.equal(await recoveryPage.locator('#progress').getAttribute('role'), 'progressbar');
    assert.equal(await recoveryPage.locator('#status-message').getAttribute('aria-live'), 'polite');

    await recoveryWindow.evaluate(window => window.close());
    assert.equal(await recoveryWindow.evaluate(window => window.isVisible()), false);
    await settingsPage.click('#repair-blobs');
    await recoveryPage.waitForFunction(() => document.getElementById('start').textContent === '检查并补齐缺失大文件');
    assert.equal(await recoveryWindow.evaluate(window => window.isVisible()), true);
    assert.equal(await recoveryPage.locator('#source-panel').isHidden(), true);
    assert.equal(await recoveryPage.locator('#destination-panel').isHidden(), true);
    assert.equal(await settingsPage.locator('body').getAttribute('data-settings-state'), 'clean');
    await recoveryWindow.evaluate(window => window.close());

    await settingsPage.fill('[name="device"]', 'desktop-smoke-updated');
    assert.equal(await settingsPage.locator('body').getAttribute('data-settings-state'), 'dirty');
    assert.equal(await settingsPage.locator('#settings-state').innerText(), '待保存');
    assert.equal(await settingsPage.locator('#save').isEnabled(), true);

    // 每个能力块跟着自己的开关，不是「非 macOS 就都有」。不支持时既要隐藏
    // 也要禁用 —— 光隐藏挡不住键盘 Tab 过去和脚本直接提交。
    for (const [capability, control] of [['launchAtLogin', 'launchAtLogin'], ['autoUpdate', 'updatesEnabled']]) {
      const supported = platformCapabilities[capability];
      assert.equal(await settingsPage.locator(`[data-capability="${capability}"]`).isHidden(), !supported);
      assert.equal(await settingsPage.locator(`[name="${control}"]`).isDisabled(), !supported);
    }

    // 托盘/菜单里改登录启动，会在设置页有未保存内容时造成一次外部变更冲突。
    // 这条只在真有登录启动项的平台上跑得起来。
    if (platformCapabilities.launchAtLogin) {
      const menuToggle = await electronApp.evaluate(async ({ Menu }) => {
        const item = Menu.getApplicationMenu().getMenuItemById('launch-at-login');
        const before = item.checked;
        await item.click({}, undefined, undefined);
        return { before, after: item.checked };
      });
      assert.deepEqual(menuToggle, { before: false, after: true });
      assert.equal(JSON.parse(await fs.readFile(settingsPath, 'utf8')).launchAtLogin, true);
      await settingsPage.waitForFunction(
        () => document.body.dataset.settingsState === 'conflict',
        undefined,
        { timeout: 5_000 }
      );
      assert.equal(await settingsPage.locator('[name="device"]').inputValue(), 'desktop-smoke-updated');
      assert.equal(await settingsPage.locator('[name="launchAtLogin"]').isChecked(), false);
      assert.equal(await settingsPage.locator('#reload-settings').isVisible(), true);
      assert.match(await settingsPage.locator('#message').innerText(), /没有被覆盖/);
    }

    const restartedPagePromise = electronApp.waitForEvent('window');
    await settingsPage.click('#save');
    await settingsPage.waitForFunction(() => document.getElementById('message').textContent === '设置已保存。');
    await settingsPage.waitForFunction(() => document.getElementById('runtime-status').textContent === '工作台运行中');
    const restartedPage = await restartedPagePromise;
    monitorRenderer(restartedPage, rendererErrors);
    await restartedPage.waitForLoadState('domcontentloaded');
    await restartedPage.waitForSelector('.workspace-sidebar');
    assert.equal(await settingsPage.locator('body').getAttribute('data-settings-state'), 'clean');
    assert.equal(await settingsPage.locator('#settings-state').innerText(), '已同步');
    assert.equal(await settingsPage.locator('#settings-form').getAttribute('aria-busy'), null);

    const saved = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    assert.equal(saved.device, 'desktop-smoke-updated');
    assert.equal(saved.launchAtLogin, platformCapabilities.launchAtLogin);
    const restartedOrigin = new URL(restartedPage.url()).origin;
    assert.notEqual(restartedOrigin, origin);
    assert.equal((await fetch(restartedOrigin)).status, 403);

    await settingsPage.fill('[name="vaultDir"]', emptyVaultDir);
    await settingsPage.check('[name="readOnly"]');
    const readOnlyPagePromise = electronApp.waitForEvent('window');
    await settingsPage.click('#save');
    await settingsPage.waitForFunction(() => document.getElementById('message').textContent === '设置已保存。');
    const readOnlyPage = await readOnlyPagePromise;
    monitorRenderer(readOnlyPage, rendererErrors);
    await readOnlyPage.waitForLoadState('domcontentloaded');
    await readOnlyPage.waitForSelector('.workspace-sidebar .readonly-status');
    assert.match(await readOnlyPage.locator('#main-content').innerText(), /vault 还是空的/);
    assert.equal(await readOnlyPage.locator('a[href="/new"]').count(), 0);
    assert.equal(await readOnlyPage.locator('script[src="/static/selection-card.js"]').count(), 0);
    assert.equal(await readOnlyPage.locator('#palette').getAttribute('data-readonly'), '1');
    const readOnlyWindow = await electronApp.browserWindow(readOnlyPage);
    await readOnlyWindow.evaluate(window => {
      window.setSize(900, 620);
      window.webContents.setZoomFactor(1.5);
    });
    await readOnlyPage.waitForTimeout(100);
    const readOnlyLayout = await readOnlyPage.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      visibleStatuses: [...document.querySelectorAll('.readonly-status')]
        .filter(status => status.getBoundingClientRect().width > 0).length,
      compactText: document.querySelector('.readonly-status-compact')?.getAttribute('aria-label')
    }));
    assert.ok(readOnlyLayout.scrollWidth <= readOnlyLayout.clientWidth, JSON.stringify(readOnlyLayout));
    assert.equal(readOnlyLayout.visibleStatuses, 1);
    assert.equal(readOnlyLayout.compactText, '只读模式：可浏览、搜索和复习，不能修改笔记');
    await readOnlyWindow.evaluate(window => window.webContents.setZoomFactor(1));
    consumeExpectedRendererError(rendererErrors, /\/delete：Failed to load resource:.*409/);
    consumeExpectedRendererError(rendererErrors, /\/edit\/smoke\/editor\.md：Failed to load resource:.*409/);
    consumeExpectedRendererError(rendererErrors, /\/calendar\?month=2026-08&day=2026-08-18：Failed to load resource:.*409/);
    consumeExpectedRendererError(rendererErrors, /\/board\/experiment：Failed to load resource:.*409/);
    assert.deepEqual(rendererErrors, []);

    const restartedWindow = await electronApp.browserWindow(readOnlyPage);
    await restartedWindow.evaluate(window => window.close());
    assert.equal(await restartedWindow.evaluate(window => window.isVisible()), false);
    // macOS 上关掉窗口后是点 Dock 图标（activate）唤回来的，其它平台走托盘/菜单。
    if (restoreOnActivate) {
      await electronApp.evaluate(({ app }) => app.emit('activate'));
    } else {
      await electronApp.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('show-main').click());
    }
    assert.equal(await restartedWindow.evaluate(window => window.isVisible()), true);

    const transactionPagePromise = electronApp.waitForEvent('window');
    const transaction = await settingsPage.evaluate(async () => {
      const current = await window.workstationSettings.get();
      const { secrets: _secretStatus, schemaVersion: _schemaVersion, ...plain } = current.settings;
      const keepSecrets = {
        anthropicApiKey: { action: 'keep' },
        journalTrackerPassword: { action: 'keep' },
        blobServerToken: { action: 'keep' }
      };
      const first = window.workstationSettings.save({
        expectedRevision: current.revision,
        settings: { ...plain, device: 'transaction-first', blobServerUrl: 'https://blobs.example.test:4100' },
        secrets: keepSecrets
      });
      const stale = window.workstationSettings.save({
        expectedRevision: current.revision,
        settings: { ...plain, device: 'transaction-stale' },
        secrets: keepSecrets
      });
      return Promise.all([first, stale]);
    });
    const transactionPage = await transactionPagePromise;
    await transactionPage.waitForLoadState('domcontentloaded');
    assert.equal(transaction[0].conflict, undefined);
    assert.equal(transaction[1].conflict, true);
    assert.equal(transaction[1].latest.revision, transaction[0].revision);
    const transactionSaved = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    assert.equal(transactionSaved.device, 'transaction-first');
    assert.equal(transactionSaved.blobServerUrl, 'https://blobs.example.test:4100');

    const childProcess = electronApp.process();
    const exited = new Promise((resolve, reject) => {
      childProcess.once('exit', resolve);
      childProcess.once('error', reject);
    });
    await electronApp.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('quit-application').click());
    await exited;
    electronApp = null;

    const databasePath = path.join(vaultDir, 'workstation.db');
    const renamedDatabasePath = path.join(vaultDir, 'workstation-closed.db');
    await fs.rename(databasePath, renamedDatabasePath);
    await fs.rename(renamedDatabasePath, databasePath);
  } finally {
    if (electronApp) {
      await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await electronApp.close().catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
