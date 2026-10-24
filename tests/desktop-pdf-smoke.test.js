const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  MANIFEST_VERSION,
  PARSE_PROFILE,
  documentId
} = require('../src/pdf/service');

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

async function writeZoteroLibrary(directory) {
  await fs.mkdir(directory, { recursive: true });
  const queuedFileName = `queue-${'long-name-'.repeat(8)}paper.pdf`;
  const database = new Database(path.join(directory, 'zotero.sqlite'));
  database.exec(`
    CREATE TABLE version (schema TEXT PRIMARY KEY, version INT NOT NULL);
    CREATE TABLE libraries (
      libraryID INTEGER PRIMARY KEY, type TEXT NOT NULL, editable INT NOT NULL, filesEditable INT NOT NULL
    );
    CREATE TABLE groups (
      groupID INTEGER PRIMARY KEY, libraryID INT NOT NULL UNIQUE, name TEXT NOT NULL,
      description TEXT NOT NULL, version INT NOT NULL
    );
    CREATE TABLE items (itemID INTEGER PRIMARY KEY, libraryID INT NOT NULL, key TEXT);
    CREATE TABLE itemAttachments (
      itemID INTEGER PRIMARY KEY,
      parentItemID INT,
      path TEXT,
      contentType TEXT,
      linkMode INT
    );
    CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY);
    CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT);
    CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value TEXT);
    CREATE TABLE itemData (itemID INT, fieldID INT, valueID INT);
    CREATE TABLE itemAnnotations (
      itemID INTEGER PRIMARY KEY, parentItemID INT, type INT,
      text TEXT, comment TEXT, color TEXT, pageLabel TEXT, sortIndex TEXT
    );
  `);
  database.prepare(`INSERT INTO version VALUES ('userdata', 130)`).run();
  database.prepare(`INSERT INTO libraries VALUES (1, 'user', 1, 1)`).run();
  database.prepare(`INSERT INTO items VALUES (1, 1, 'PAPER001')`).run();
  database.prepare(`INSERT INTO items VALUES (2, 1, 'READY001')`).run();
  database.prepare(`INSERT INTO items VALUES (3, 1, 'QUEUE001')`).run();
  database.prepare(`INSERT INTO itemAttachments VALUES (2, 1, 'storage:ready-paper.pdf', 'application/pdf', 0)`).run();
  database.prepare(`INSERT INTO itemAttachments VALUES (3, 1, ?, 'application/pdf', 1)`).run(`storage:${queuedFileName}`);
  database.prepare(`INSERT INTO fields VALUES (110, 'title')`).run();
  database.prepare(`INSERT INTO itemDataValues VALUES (500, '平台治理中的因果识别')`).run();
  database.prepare(`INSERT INTO itemData VALUES (1, 110, 500)`).run();
  database.close();

  const readyDirectory = path.join(directory, 'storage', 'READY001');
  const queuedDirectory = path.join(directory, 'storage', 'QUEUE001');
  await Promise.all([
    fs.mkdir(readyDirectory, { recursive: true }),
    fs.mkdir(queuedDirectory, { recursive: true })
  ]);
  const readyPdf = path.join(readyDirectory, 'ready-paper.pdf');
  await Promise.all([
    fs.writeFile(readyPdf, '%PDF-1.7\nready desktop fixture\n'),
    fs.writeFile(path.join(queuedDirectory, queuedFileName), '%PDF-1.7\nqueued desktop fixture\n')
  ]);
  return { queuedFileName, readyPdf };
}

async function writeReadyCache(vaultDir, readyPdf) {
  const libraryId = 'user';
  const attachmentKey = 'READY001';
  const id = documentId(libraryId, attachmentKey);
  const cacheDirectory = path.join(vaultDir, '.workstation', 'mineru', libraryId, attachmentKey);
  const source = await fs.readFile(readyPdf);
  const stats = await fs.stat(readyPdf);
  const contentList = [
    { type: 'title', text: '识别设计', page_idx: 0 },
    { type: 'text', text: '工具变量用于识别平台政策的因果效应。', page_idx: 0 },
    { type: 'title', text: '稳健性检验', page_idx: 1 },
    { type: 'text', text: '安慰剂检验支持主要结论，并排除了同期冲击。', page_idx: 1 }
  ];
  const timestamp = '2026-08-30T00:00:00.000Z';
  const manifest = {
    version: MANIFEST_VERSION,
    parseProfile: PARSE_PROFILE,
    documentId: id,
    libraryId,
    attachmentKey,
    parentKey: 'PAPER001',
    title: '平台治理中的因果识别',
    fileName: 'ready-paper.pdf',
    storagePath: 'storage:ready-paper.pdf',
    state: 'ready',
    batchId: 'desktop_fixture_batch',
    submissionConfirmed: true,
    progress: null,
    source: {
      sha256: crypto.createHash('sha256').update(source).digest('hex'),
      size: stats.size,
      mtimeMs: stats.mtimeMs
    },
    pageCount: 2,
    error: '',
    createdAt: timestamp,
    updatedAt: timestamp
  };
  await fs.mkdir(cacheDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(cacheDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    fs.writeFile(path.join(cacheDirectory, 'full.md'), '# 平台治理中的因果识别\n\n安慰剂检验支持主要结论。\n', 'utf8'),
    fs.writeFile(path.join(cacheDirectory, 'content_list.json'), `${JSON.stringify(contentList, null, 2)}\n`, 'utf8')
  ]);
  return { cacheDirectory, documentId: id };
}

async function assertNoHorizontalOverflow(page, label) {
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    mainRight: Math.round(document.getElementById('main-content').getBoundingClientRect().right)
  }));
  assert.ok(layout.scrollWidth <= layout.clientWidth, `${label} ${JSON.stringify(layout)}`);
  assert.ok(layout.mainRight <= layout.clientWidth + 1, `${label} ${JSON.stringify(layout)}`);
}

const pdfDesktopSkip = !electron
  ? '尚未安装桌面测试依赖'
  : !['win32', 'darwin'].includes(process.platform)
    ? 'MinerU Token 密文流程只在 Windows 与 macOS 桌面目标验证'
    : false;

test('Electron PDF 确认、轮询、中文检索与正文预览黄金路径', {
  skip: pdfDesktopSkip,
  timeout: 75_000
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-electron-pdf-'));
  const userDataDir = path.join(root, 'user-data');
  const settingsDirectory = path.join(userDataDir, 'workstation-data');
  const settingsPath = path.join(settingsDirectory, 'settings.json');
  const vaultDir = path.join(root, 'vault');
  const zoteroDataDir = path.join(root, 'zotero');
  const rendererErrors = [];
  const testToken = 'desktop-fixture-mineru-token';
  let electronApp;

  try {
    await Promise.all([
      fs.mkdir(settingsDirectory, { recursive: true }),
      fs.mkdir(path.join(vaultDir, 'notes'), { recursive: true })
    ]);
    const zoteroFixture = await writeZoteroLibrary(zoteroDataDir);
    const ready = await writeReadyCache(vaultDir, zoteroFixture.readyPdf);
    await fs.writeFile(settingsPath, `${JSON.stringify({
      schemaVersion: 3,
      vaultDir,
      device: 'desktop-pdf-smoke',
      readOnly: false,
      syncEnabled: false,
      syncIntervalMinutes: 15,
      zoteroApi: 'http://127.0.0.1:1/api/users/0',
      zoteroDataDir,
      launchAtLogin: false,
      updatesEnabled: false,
      remindersEnabled: false,
      reminderLeadMinutes: 10,
      secrets: {}
    }, null, 2)}\n`, 'utf8');

    const launchEnvironment = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
    delete launchEnvironment.ELECTRON_RUN_AS_NODE;
    const userDataArgument = `--workstation-user-data=${userDataDir}`;
    const launchOptions = packagedExecutable
      ? {
          executablePath: path.resolve(packagedExecutable),
          args: ['--password-store=basic', '--workstation-smoke-test', userDataArgument],
          env: launchEnvironment
        }
      : {
          args: ['--password-store=basic', projectDir, userDataArgument],
          env: launchEnvironment
        };

    electronApp = await electron.launch(launchOptions);
    const initialPage = await electronApp.firstWindow();
    monitorRenderer(initialPage, rendererErrors);
    await initialPage.waitForSelector('.workspace-sidebar');
    assert.equal(
      await electronApp.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable()),
      true,
      '桌面 smoke 环境必须提供 Electron safeStorage'
    );

    const settingsPagePromise = electronApp.waitForEvent('window');
    await electronApp.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('show-settings').click());
    const settingsPage = await settingsPagePromise;
    monitorRenderer(settingsPage, rendererErrors);
    await settingsPage.waitForSelector('#settings-form');
    await settingsPage.waitForFunction(() => document.body.dataset.settingsState === 'clean');
    assert.equal(await settingsPage.locator('#mineru-token-status').innerText(), '未配置');
    assert.equal(await settingsPage.locator('[name="mineruApiToken"]').inputValue(), '');

    await settingsPage.fill('[name="mineruApiToken"]', testToken);
    assert.equal(await settingsPage.locator('#save').isEnabled(), true);
    const restartedPagePromise = electronApp.waitForEvent('window');
    await settingsPage.click('#save');
    const mainPage = await restartedPagePromise;
    monitorRenderer(mainPage, rendererErrors);
    await mainPage.waitForSelector('.workspace-sidebar');
    await settingsPage.waitForFunction(() => document.getElementById('message').textContent === '设置已保存。');
    assert.equal(await settingsPage.locator('#mineru-token-status').innerText(), '已安全保存');
    assert.equal(await settingsPage.locator('[name="mineruApiToken"]').inputValue(), '');

    const persistedText = await fs.readFile(settingsPath, 'utf8');
    const persisted = JSON.parse(persistedText);
    assert.ok(persisted.secrets.mineruApiToken);
    assert.notEqual(persisted.secrets.mineruApiToken, testToken);
    assert.equal(persistedText.includes(testToken), false);

    const queuedDocumentId = documentId('user', 'QUEUE001');
    const parseRequests = [];
    let statusRequests = 0;
    await mainPage.route('**/library/pdfs/parse', async route => {
      parseRequests.push({
        method: route.request().method(),
        payload: route.request().postDataJSON()
      });
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          documentId: queuedDocumentId,
          state: 'running',
          progress: null,
          error: ''
        })
      });
    });
    await mainPage.route(/\/library\/pdfs\/[a-f0-9]{32}\/status$/, async route => {
      statusRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(statusRequests === 1 ? {
          ok: true,
          documentId: queuedDocumentId,
          state: 'running',
          progress: { extractedPages: 1, totalPages: 2 },
          error: ''
        } : {
          ok: true,
          documentId: queuedDocumentId,
          state: 'ready',
          progress: null,
          error: '',
          pageCount: 2
        })
      });
    });

    const origin = new URL(mainPage.url()).origin;
    const mainWindow = await electronApp.browserWindow(mainPage);
    await mainWindow.evaluate(window => window.setSize(900, 620));
    await mainPage.goto(`${origin}/library`);
    await mainPage.waitForSelector(`[data-pdf-row][data-document-id="${queuedDocumentId}"]`);
    assert.match(await mainPage.locator('.library-heading').innerText(), /2 个 PDF/);
    const readyRow = mainPage.locator(`[data-pdf-row][data-document-id="${ready.documentId}"]`);
    const queuedRow = mainPage.locator(`[data-pdf-row][data-document-id="${queuedDocumentId}"]`);
    assert.equal(await readyRow.getAttribute('data-pdf-state'), 'ready');
    assert.match(await readyRow.locator('[data-pdf-preview]').innerText(), /2 页/);
    assert.equal(await queuedRow.getAttribute('data-pdf-state'), 'unparsed');
    assert.match(await queuedRow.locator('.pdf-file-name').innerText(), /long-name/);
    await assertNoHorizontalOverflow(mainPage, '文献页');

    await queuedRow.locator('[data-parse-pdf]').click();
    const confirmation = mainPage.locator('[data-pdf-dialog][open]');
    await confirmation.waitFor();
    assert.equal(parseRequests.length, 0, '打开确认框不能发送解析请求');
    assert.equal(statusRequests, 0, '打开确认框不能开始状态轮询');
    assert.match(await confirmation.innerText(), /上传至 MinerU 精确解析 API/);
    assert.match(await confirmation.innerText(), /200 MB \/ 200 页/);
    assert.match(await confirmation.innerText(), /Git 同步/);
    assert.match(await confirmation.innerText(), /不会保留上传用的 PDF 副本或结果 ZIP/);

    const reloaded = mainPage.waitForEvent('framenavigated', {
      predicate: frame => frame === mainPage.mainFrame(),
      timeout: 10_000
    });
    await confirmation.locator('[data-pdf-dialog-submit]').click();
    await mainPage.waitForFunction(id => {
      const row = document.querySelector(`[data-pdf-row][data-document-id="${id}"]`);
      return row?.querySelector('[data-pdf-status]')?.textContent === 'MinerU 解析中'
        && row?.querySelector('[data-pdf-progress]')?.textContent === '1 / 2 页';
    }, queuedDocumentId);
    assert.deepEqual(parseRequests, [{
      method: 'POST',
      payload: { libraryId: 'user', attachmentKey: 'QUEUE001' }
    }]);
    await reloaded;
    await mainPage.waitForSelector(`[data-pdf-row][data-document-id="${queuedDocumentId}"]`);
    assert.equal(statusRequests, 2);

    await mainPage.locator('a[href="/library/pdfs/search"]').first().click();
    await mainPage.waitForSelector('input[aria-label="搜索 PDF 正文"]');
    await mainPage.fill('input[aria-label="搜索 PDF 正文"]', '安慰剂检验');
    await mainPage.locator('.searchform button[type="submit"]').click();
    const result = mainPage.locator('.pdf-results li').first();
    await result.waitFor();
    assert.equal(await mainPage.locator('.pdf-results li').count(), 1);
    assert.match(await result.innerText(), /平台治理中的因果识别/);
    assert.match(await result.innerText(), /第 2 页/);
    assert.match(await result.locator('.snippet').innerText(), /安慰剂检验支持主要结论/);
    const resultLink = result.locator('a.result-title');
    assert.equal(
      await resultLink.getAttribute('href'),
      `/library/pdfs/${ready.documentId}?chunk=1#chunk-1`
    );
    await assertNoHorizontalOverflow(mainPage, 'PDF 搜索页');

    await resultLink.click();
    await mainPage.waitForSelector('[data-pdf-chunk="1"].is-selected');
    assert.match(await mainPage.locator('.pdf-page-heading').innerText(), /第 2 页/);
    assert.match(await mainPage.locator('[data-pdf-chunk="1"]').innerText(), /安慰剂检验支持主要结论/);
    assert.equal(await mainPage.locator('[data-pdf-chunk="0"]').count(), 0);
    await assertNoHorizontalOverflow(mainPage, 'PDF 正文预览页');

    await mainPage.locator('.workspace-sidebar a[href="/ask"]').click();
    await mainPage.waitForSelector('.searchform input[name="q"]');
    assert.match(await mainPage.locator('.hero').innerText(), /问资料库/);
    assert.match(await mainPage.locator('.integration-status').innerText(), /只做本地检索/);
    const askQuestion = '为什么安慰剂检验支持主要结论';
    await mainPage.fill('.searchform input[name="q"]', askQuestion);
    await Promise.all([
      mainPage.waitForURL(url => url.pathname === '/ask' && url.searchParams.get('q') === askQuestion),
      mainPage.locator('.searchform button[type="submit"]').click()
    ]);
    const askResults = mainPage.locator('.results li');
    const askPageText = await mainPage.locator('#main-content').innerText();
    assert.equal(await askResults.count(), 1, askPageText);
    const askResult = askResults.first();
    assert.match(await askResult.innerText(), /平台治理中的因果识别/);
    assert.match(await askResult.innerText(), /PDF/);
    assert.match(await askResult.innerText(), /第 2 页/);
    assert.match(await askResult.innerText(), /稳健性检验/);
    const askCitation = askResult.locator('a.result-title');
    assert.equal(
      await askCitation.getAttribute('href'),
      `/library/pdfs/${ready.documentId}?chunk=1#chunk-1`
    );
    await assertNoHorizontalOverflow(mainPage, '问资料库结果页');

    await askCitation.click();
    await mainPage.waitForSelector('[data-pdf-chunk="1"].is-selected');
    assert.match(await mainPage.locator('.pdf-page-heading').innerText(), /第 2 页/);
    assert.match(await mainPage.locator('[data-pdf-chunk="1"]').innerText(), /安慰剂检验支持主要结论/);
    await assertNoHorizontalOverflow(mainPage, '问资料库引用预览页');

    assert.deepEqual((await fs.readdir(ready.cacheDirectory)).sort(), [
      'content_list.json',
      'full.md',
      'manifest.json'
    ]);
    assert.equal(
      await fs.stat(path.join(vaultDir, '.workstation', 'mineru', 'user', 'QUEUE001')).then(() => true, () => false),
      false,
      'renderer 假解析不能触发真实后端上传任务'
    );
    assert.deepEqual(rendererErrors, []);
  } finally {
    if (electronApp) {
      await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await electronApp.close().catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
