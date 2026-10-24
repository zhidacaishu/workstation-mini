const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let electron;
try {
  ({ _electron: electron } = require('playwright-core'));
} catch {}

const projectDir = path.resolve(__dirname, '..');

test('清理已 rename 的恢复残留后直接打开已保存资料库', {
  skip: !electron && '尚未安装桌面测试依赖',
  timeout: 45_000
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-electron-residue-'));
  const userDataDir = path.join(root, 'user-data');
  const settingsDir = path.join(userDataDir, 'workstation-data');
  const vaultDir = path.join(root, 'recovered-vault');
  const sessionId = 'residue-smoke';
  const stagingRoot = path.join(root, `.workstation-recovery-${sessionId}`);
  const journalPath = path.join(settingsDir, 'recovery-session.json');
  let electronApp;

  try {
    await Promise.all([
      fs.mkdir(settingsDir, { recursive: true }),
      fs.mkdir(path.join(vaultDir, 'notes'), { recursive: true })
    ]);
    await fs.writeFile(path.join(vaultDir, 'notes', 'recovered.md'), '# 残留清理后可用\n', 'utf8');
    await fs.writeFile(path.join(settingsDir, 'settings.json'), `${JSON.stringify({
      schemaVersion: 1,
      vaultDir,
      device: 'residue-smoke',
      syncEnabled: false,
      syncIntervalMinutes: 15,
      launchAtLogin: false,
      blobServerUrl: '',
      secrets: {}
    }, null, 2)}\n`, 'utf8');
    await fs.writeFile(journalPath, `${JSON.stringify({
      version: 1,
      sessionId,
      mode: 'restore',
      stagingRoot,
      destinationPath: vaultDir,
      phase: 'renamed',
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:00.000Z'
    }, null, 2)}\n`, 'utf8');

    const launchEnvironment = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
    delete launchEnvironment.ELECTRON_RUN_AS_NODE;
    electronApp = await electron.launch({
      args: [projectDir, `--workstation-user-data=${userDataDir}`],
      env: launchEnvironment
    });
    const recoveryPage = await electronApp.firstWindow();
    await recoveryPage.waitForFunction(() => document.body.dataset.phase === 'residue');
    assert.equal(await recoveryPage.locator('#discard-staging').isVisible(), true);

    const mainPagePromise = electronApp.waitForEvent('window');
    await recoveryPage.click('#discard-staging');
    const mainPage = await mainPagePromise;
    await mainPage.waitForSelector('.workspace-sidebar');
    await recoveryPage.waitForFunction(() => !document.getElementById('recovery-form').hasAttribute('aria-busy'));
    assert.equal(await fs.stat(journalPath).then(() => true, () => false), false);

    const origin = new URL(mainPage.url()).origin;
    await mainPage.goto(`${origin}/note/recovered.md`);
    await mainPage.waitForSelector('.prose');
    assert.match(await mainPage.locator('.prose').innerText(), /残留清理后可用/);
  } finally {
    if (electronApp) {
      await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await electronApp.close().catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
