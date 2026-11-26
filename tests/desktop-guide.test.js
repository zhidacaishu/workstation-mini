const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { _electron: electron } = require('playwright-core');

const progressIs = text => document.querySelector('[data-guide-progress]').textContent === text;

/** 高亮框要完整罩住目标，卡片要整张落在窗口里、并且不压住目标。 */
async function spotlightOf(page, selector) {
  // 等待目标与高亮框一起完成布局；仅观察高亮框两帧不变可能读到旧位置。
  await page.waitForFunction(selector => {
    const spot = document.querySelector('[data-guide-spot]').getBoundingClientRect();
    const card = document.querySelector('[data-guide-card]').getBoundingClientRect();
    const targets = [...document.querySelectorAll(selector)].map(element => element.getBoundingClientRect());
    return targets.length && targets.every(target => spot.left <= target.left && spot.top <= target.top
      && spot.right >= target.right && spot.bottom >= target.bottom && card.left >= target.right)
      && card.left >= 0 && card.top >= 0 && card.right <= document.documentElement.clientWidth
      && card.bottom <= document.documentElement.clientHeight;
  }, selector, { polling: 'raf' });
  return page.evaluate(selector => {
    const box = element => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
    const targets = [...document.querySelectorAll(selector)].map(box);
    return {
      spot: box(document.querySelector('[data-guide-spot]')),
      card: box(document.querySelector('[data-guide-card]')),
      target: {
        left: Math.min(...targets.map(r => r.left)), top: Math.min(...targets.map(r => r.top)),
        right: Math.max(...targets.map(r => r.right)), bottom: Math.max(...targets.map(r => r.bottom))
      },
      viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }
    };
  }, selector);
}

function assertSpotlight({ spot, card, target, viewport }, label) {
  assert.ok(spot.left <= target.left && spot.top <= target.top && spot.right >= target.right && spot.bottom >= target.bottom, label + '：高亮框罩住目标');
  assert.ok(card.left >= 0 && card.top >= 0 && card.right <= viewport.width && card.bottom <= viewport.height, label + '：卡片完整可见');
  assert.ok(card.left >= target.right, label + '：卡片不压住目标');
}

test('界面导览、上手清单与上手指南：首次显示、进度、跳过、隐藏和重看', { timeout: 90000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-guide-desktop-'));
  const userData = path.join(root, 'user');
  const vault = path.join(root, "vault's notes");
  let app, page, passed = false;
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => electron.launch(process.env.WORKSTATION_EXECUTABLE
    ? { executablePath: process.env.WORKSTATION_EXECUTABLE, args: ['--workstation-smoke-test', '--workstation-user-data=' + userData], env, timeout: 20000 }
    : { args: [path.resolve(__dirname, '..'), '--workstation-user-data=' + userData], env });
  async function close() { await app.evaluate(({ app }) => app.exit(0)); await app.close().catch(() => {}); app = null; }
  try {
    await fs.mkdir(path.join(vault, 'notes'), { recursive: true });
    await fs.mkdir(path.join(userData, 'workstation-data'), { recursive: true });
    const configFile = path.join(userData, 'workstation-data', 'settings.json');
    await fs.writeFile(configFile, JSON.stringify({ schemaVersion: 5, vaultDir: vault, syncEnabled: false, device: 'guide' }));
    app = await launch(); page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width: 1280, height: 800 });
    // 减少动效时高亮框直接就位，测量不必等过渡动画。
    await page.emulateMedia({ reducedMotion: 'reduce' });

    // 首次打开：欢迎页居中，没有「上一步」，可以「以后再说」。
    await page.waitForSelector('#onboarding[open]');
    assert.match(await page.locator('#guide-title').textContent(), /欢迎/);
    assert.equal(await page.locator('[data-guide-prev]').isVisible(), false);
    assert.equal(await page.locator('[data-guide-later]').isVisible(), true);
    assert.equal(await page.locator('#onboarding').evaluate(e => e.classList.contains('is-centered')), true);

    // 每一站高亮侧栏里的真实入口。
    await page.locator('[data-guide-next]').click();
    await page.waitForFunction(progressIs, '1 / 6');
    assertSpotlight(await spotlightOf(page, '.workspace-search'), '搜索');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(progressIs, '2 / 6');
    assertSpotlight(await spotlightOf(page, '[data-nav="notes"]'), '笔记');
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(progressIs, '1 / 6');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(progressIs, '3 / 6');
    assert.match(await page.locator('#guide-title').textContent(), /研究项目与计划/);
    assertSpotlight(await spotlightOf(page, '[data-nav="projects"], [data-nav="plan"]'), '研究项目与计划');

    // 进度跨页面保留。
    await page.reload();
    await page.waitForSelector('#onboarding[open]');
    await page.waitForFunction(progressIs, '3 / 6');

    // 最小窗口、明暗主题下卡片和高亮都完整可见。
    await page.setViewportSize({ width: 900, height: 620 });
    // 矮窗口里侧栏换成紧凑排布，导览在缩放停下后会再对齐一次。
    await page.waitForTimeout(300);
    for (const scheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      for (const [step, selector] of [['3 / 6', '[data-nav="projects"], [data-nav="plan"]'], ['5 / 6', '.workspace-tools'], ['6 / 6', '.workspace-sidebar-footer']]) {
        while (await page.locator('[data-guide-progress]').textContent() !== step) {
          await page.locator('[data-guide-next]').click();
        }
        assertSpotlight(await spotlightOf(page, selector), scheme + ' ' + step);
        assert.notEqual(await page.locator('[data-guide-card]').evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)');
      }
      if (process.env.WORKSTATION_VISUAL_OUTPUT) {
        await fs.mkdir(process.env.WORKSTATION_VISUAL_OUTPUT, { recursive: true });
        await page.screenshot({ path: path.join(process.env.WORKSTATION_VISUAL_OUTPUT, 'tour-' + scheme + '.png') });
      }
      while (await page.locator('[data-guide-progress]').textContent() !== '3 / 6') {
        await page.locator('[data-guide-prev]').click();
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });

    // Esc 等同于跳过：关掉、记住，不再自动弹出。
    await page.keyboard.press('Escape');
    await page.waitForSelector('#onboarding', { state: 'hidden' });
    assert.equal((await page.evaluate(() => window.workstationDesktop.getGuide())).status, 'skipped');
    await page.reload();
    await page.waitForSelector('[data-onboarding-card]');
    assert.equal(await page.locator('#onboarding').isVisible(), false);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    // 今日页的上手清单：新资料库从第一步开始，可以隐藏。
    assert.match(await page.locator('[data-onboarding-card]').textContent(), /下一步：写下第一篇笔记/);
    await page.locator('[data-onboarding-hide]').click();
    await page.waitForSelector('[data-onboarding-card]', { state: 'hidden' });
    assert.equal((await page.evaluate(() => window.workstationDesktop.getGuide())).checklist, 'hidden');
    // 隐藏的退场不能留下 opacity:0 的填充效果，撤销入场结束后仍可见。
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    const checklist = page.locator('[data-onboarding-card]');
    await checklist.waitFor({ state: 'visible' });
    await checklist.evaluate(el => Promise.allSettled(el.getAnimations().map(animation => animation.finished)));
    assert.equal(await checklist.evaluate(el => getComputedStyle(el).opacity), '1');
    await page.locator('[data-onboarding-hide]').click();
    await checklist.waitFor({ state: 'hidden' });
    await page.reload();
    await page.waitForSelector('.desk-header');
    assert.equal(await page.locator('[data-onboarding-card]').count(), 0);

    // 重启后状态仍在；侧栏问号打开上手指南页，可以把清单找回来。
    await close();
    app = await launch(); page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForSelector('.workspace-sidebar');
    await page.waitForFunction(() => Boolean(window.workstationDesktop));
    assert.deepEqual(await page.evaluate(() => window.workstationDesktop.getGuide()), { version: 2, step: 3, status: 'skipped', checklist: 'hidden' });
    assert.equal(await page.locator('#onboarding').isVisible(), false);
    await page.locator('[data-nav="guide"]').click();
    await page.waitForSelector('.guide-page');
    assert.equal(await page.locator('[data-nav="guide"]').getAttribute('aria-current'), 'page');
    await page.locator('[data-onboarding-show]').click();
    await page.waitForSelector('[data-onboarding-restore]', { state: 'hidden' });
    assert.equal((await page.evaluate(() => window.workstationDesktop.getGuide())).checklist, 'shown');

    // Git 一节：按真实路径生成命令，可以一键复制；打开设置不替用户开启同步。
    const commands = await page.locator('[data-guide-git-commands]').textContent();
    assert.ok(commands.includes("vault'\"'\"'s notes"));
    assert.match(commands, /git init/);
    await page.locator('[data-copy="git-commands"]').click();
    await page.waitForFunction(() => document.querySelector('[data-copy="git-commands"]').textContent === '已复制');
    assert.equal((await app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n'), commands);
    const newWindow = app.waitForEvent('window');
    await page.locator('[data-guide-settings]').click();
    const settings = await newWindow;
    await settings.waitForSelector('#settings-form');
    assert.equal(await settings.locator('[name=syncEnabled]').isChecked(), false);
    await settings.close();

    // 从指南页重看导览：直接从第一站开始，看完记为完成，焦点回到按钮。
    await page.locator('[data-guide-start]').click();
    await page.waitForSelector('#onboarding[open]');
    await page.waitForFunction(progressIs, '1 / 6');
    for (let i = 2; i <= 6; i++) {
      await page.locator('[data-guide-next]').click();
      await page.waitForFunction(progressIs, i + ' / 6');
    }
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.waitForSelector('#onboarding', { state: 'hidden' });
    assert.equal((await page.evaluate(() => window.workstationDesktop.getGuide())).status, 'completed');
    assert.equal(await page.locator('[data-guide-start]').evaluate(e => e === document.activeElement), true);

    // 最后一站的链接：记为完成并去上手指南。
    const origin = new URL(page.url()).origin;
    await page.evaluate(() => window.workstationDesktop.saveGuide({ step: 6, status: 'active' }));
    await page.goto(origin + '/');
    await page.waitForSelector('#onboarding[open]');
    await page.locator('[data-guide-finish]').click();
    await page.waitForURL(origin + '/guide');
    assert.equal((await page.evaluate(() => window.workstationDesktop.getGuide())).status, 'completed');

    // 自动导览不打断编辑。
    await page.evaluate(() => window.workstationDesktop.saveGuide({ step: 1, status: 'active' }));
    await page.goto(origin + '/new');
    await page.waitForSelector('[name=path]');
    assert.equal(await page.locator('#onboarding').isVisible(), false, '编辑时不得自动打断');

    // 整个过程不改资料库、不开同步、不建仓库。
    assert.equal(JSON.parse(await fs.readFile(configFile)).syncEnabled, false);
    await assert.rejects(fs.stat(path.join(vault, '.git')), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(path.join(vault, 'notes')), []);
    assert.deepEqual(errors, []);
    passed = true;
  } finally {
    if (!passed) { console.error(root); await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); }
    if (app) await close().catch(() => {});
    if (passed) await fs.rm(root, { recursive: true, force: true });
  }
});
