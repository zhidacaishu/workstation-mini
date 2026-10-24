const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const zotero = require('../integrations/zotero');
const { createMineruClient, MAX_PDF_BYTES, safeMessage } = require('../integrations/mineru');
const { tokenizeToText } = require('../segment');
const { replaceFile } = require('../vault/atomic');
const { ensureSafeTargetParent, toRelative } = require('../vault/paths');
const { readMineruArchive } = require('./archive');
const { parseContentList } = require('./content');

const MANIFEST_VERSION = 1;
const PARSE_PROFILE = 'mineru-v4-vlm-content-v1';
const ACTIVE_STATES = new Set([
  'queued', 'preparing', 'uploading', 'submitted', 'pending', 'running',
  'downloading', 'indexing'
]);
const RECOVERABLE_WITH_BATCH = new Set([
  'submitted', 'pending', 'running', 'downloading'
]);
const INSPECT_CONCURRENCY = 8;
const MAX_REHASH_PER_PASS = 8;
const STOP_RECONCILE_GRACE_MS = 2_000;
// 一轮对账里「附件不见了」的删除候选超过这个数、且占本机名下缓存的比例超过
// 下面的阈值时，整轮不删。这种形状几乎总是「Zotero 数据还没同步完 / 选错了
// 数据目录」而不是用户真的一口气删了一大批文献 —— 前者删错了要重新上传计费，
// 后者多留几轮缓存没有任何代价。
const MASS_REMOVAL_MIN = 5;
const MASS_REMOVAL_RATIO = 0.25;
const OWNER_DEVICE_PATTERN = /^[a-z0-9_-]{1,128}$/;
const FOREIGN_JOB_TAKEOVER_MS = 3 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function documentId(libraryId, attachmentKey) {
  return crypto.createHash('sha256')
    .update(`${String(libraryId)}:${String(attachmentKey)}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

// 库的全局身份（见 zotero.js 的 globalLibraryId）：`user` 或 `group-<groupID>`。
const LIBRARY_PATTERN = /^(user|group-[1-9]\d{0,15})$/;
// 旧版本用 Zotero 的本机 libraryID 做目录名。这种目录只读加载，等拿到 Zotero
// 快照时再迁移到全局身份下（见 migrateLegacyCaches）。
const LEGACY_LIBRARY_PATTERN = /^\d+$/;

function validateIdentity(libraryId, attachmentKey, { legacy = false } = {}) {
  const library = String(libraryId ?? '');
  const key = String(attachmentKey || '');
  const pattern = legacy ? LEGACY_LIBRARY_PATTERN : LIBRARY_PATTERN;
  if (!pattern.test(library) || !/^[A-Za-z0-9]+$/.test(key)) {
    throw new Error('Zotero PDF 附件身份无效。');
  }
  return { libraryId: library, attachmentKey: key };
}

/**
 * 旧 manifest 迁移到全局库身份后的样子。
 *
 * 只换 libraryId 和由它派生的 documentId，其它字段（包括 updatedAt）和键的顺序
 * 原样保留：同一份旧缓存可能在几台设备上各自迁移，产出的文件必须逐字节相同，
 * Git 合并两边「删旧目录、加新目录」时才不会冲突。
 */
function migratedManifest(raw, libraryId) {
  return Object.fromEntries(Object.entries(raw).map(([field, value]) => {
    if (field === 'libraryId') return [field, libraryId];
    if (field === 'documentId') return [field, documentId(libraryId, raw.attachmentKey)];
    return [field, value];
  }));
}

function identityKey(libraryId, attachmentKey) {
  const identity = validateIdentity(libraryId, attachmentKey);
  return `${identity.libraryId}:${identity.attachmentKey}`;
}

function publicStatus(manifest) {
  if (!manifest) return { state: 'unparsed', progress: null, error: '' };
  return {
    documentId: manifest.documentId,
    state: manifest.state,
    progress: manifest.progress || null,
    error: manifest.error || '',
    updatedAt: manifest.updatedAt || '',
    pageCount: Number(manifest.pageCount) || 0
  };
}

function createPdfLibraryService({
  config,
  db,
  logger = console,
  mineru = createMineruClient({ token: config.mineruApiToken }),
  readLibraryData = zotero.readLibraryData,
  openAttachmentPdf = zotero.openAttachmentPdf,
  inspectAttachmentPdf = zotero.inspectAttachmentPdf,
  readArchive = readMineruArchive,
  parseContent = parseContentList
}) {
  const manifests = new Map();
  const scheduled = new Set();
  // 正在被某条路径独占的文档。改 manifest / 删缓存目录 / 动派生索引的路径有三条：
  // 后台解析任务、enqueue、文献页的对账。它们原来互不知情，对账在一次几秒的
  // 重新哈希 await 期间拿着过期的 manifest 对象，醒来后能把这期间刚解析完的
  // 成果连目录带索引一起删掉。这个集合让三条路径对同一篇文献互斥；对账遇到
  // 占用中的文档直接跳过而不是等待，否则打开文献页会被一个几分钟的解析卡住。
  const busy = new Set();
  let queue = Promise.resolve();
  let reconciling = Promise.resolve();
  let initialization = null;
  let stopping = false;
  let activeController = null;
  // manifest 随资料库进 Git，会出现在别的设备上。libraryId 是 Zotero 的**本机**
  // 自增编号：同一个群组库在两台电脑上的编号通常不同，新电脑上 Zotero 首次同步
  // 没跑完时库里也还缺条目。在那些设备上「快照里找不到这个附件」不代表它被删了，
  // 而删掉的目录会被下一轮 git add -A 推回所有设备。所以不可逆的清理只允许
  // 创建（或最近一次显式重新解析）这份缓存的设备来做。
  const device = OWNER_DEVICE_PATTERN.test(String(config.device || '')) ? String(config.device) : '';

  function ownedHere(manifest) {
    return Boolean(device) && manifest?.ownerDevice === device;
  }

  // 归属于别的设备的 manifest，这台只读不写：两边同时轮询、下载、改写同一份
  // manifest，下一轮 Git 同步就是一个 rebase 冲突。旧版本写的 manifest 没有
  // 归属，除了不做不可逆清理之外保持原行为。
  function ownedElsewhere(manifest) {
    return Boolean(manifest?.ownerDevice) && !ownedHere(manifest);
  }

  // 别的设备上的任务停在 active 状态太久，多半是那台机器已经不用了。
  // 超过远端轮询上限（2 小时）再留余量之后，才允许这台显式重新解析来接手。
  function abandonedElsewhere(manifest) {
    const updatedAt = Date.parse(manifest?.updatedAt || '');
    return ownedElsewhere(manifest)
      && (!Number.isFinite(updatedAt) || Date.now() - updatedAt > FOREIGN_JOB_TAKEOVER_MS);
  }

  function pathsFor(identity) {
    const validated = validateIdentity(identity.libraryId, identity.attachmentKey, {
      legacy: identity.legacy === true
    });
    const directory = path.join(
      config.mineruCacheDir,
      validated.libraryId,
      validated.attachmentKey
    );
    return {
      directory,
      manifest: path.join(directory, 'manifest.json'),
      markdown: path.join(directory, 'full.md'),
      contentList: path.join(directory, 'content_list.json')
    };
  }

  async function ensureDirectory(identity) {
    const targets = pathsFor(identity);
    await ensureSafeTargetParent(config.vaultDir, targets.manifest, { create: true });
    return targets;
  }

  async function atomicText(target, content) {
    const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await fsp.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    try {
      await replaceFile(temporary, target);
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function saveManifest(manifest) {
    // 旧目录下的缓存只读：往那里写等于在迁移之前又造出一份按本机编号存的数据。
    if (manifest.legacy) throw new Error('旧版本的 PDF 解析缓存尚未迁移，不能修改。');
    const targets = await ensureDirectory(manifest);
    const { legacy, ...persisted } = manifest; // eslint-disable-line no-unused-vars
    const next = {
      ...persisted,
      version: MANIFEST_VERSION,
      parseProfile: PARSE_PROFILE,
      updatedAt: nowIso()
    };
    await atomicText(targets.manifest, `${JSON.stringify(next, null, 2)}\n`);
    manifests.set(next.documentId, next);
    return next;
  }

  function safeManifest(value, { legacy = false } = {}) {
    if (!value || value.version !== MANIFEST_VERSION || value.parseProfile !== PARSE_PROFILE) return null;
    const identity = validateIdentity(value.libraryId, value.attachmentKey, { legacy });
    const expectedId = documentId(identity.libraryId, identity.attachmentKey);
    if (value.documentId !== expectedId || typeof value.state !== 'string') return null;
    return {
      ...value,
      ...identity,
      legacy,
      documentId: expectedId,
      parentKey: String(value.parentKey || ''),
      title: String(value.title || value.fileName || ''),
      fileName: String(value.fileName || ''),
      storagePath: String(value.storagePath || ''),
      ownerDevice: OWNER_DEVICE_PATTERN.test(String(value.ownerDevice || '')) ? String(value.ownerDevice) : '',
      error: safeMessage(value.error, ''),
      batchId: /^[A-Za-z0-9_-]+$/.test(String(value.batchId || '')) ? String(value.batchId) : '',
      submissionConfirmed: value.submissionConfirmed === true
        || ['submitted', 'pending', 'running', 'downloading', 'indexing', 'ready'].includes(value.state)
    };
  }

  async function readManifestEntry(libraryName, attachmentName) {
    const directory = path.join(config.mineruCacheDir, libraryName, attachmentName);
    const manifestPath = path.join(directory, 'manifest.json');
    const raw = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    if (LEGACY_LIBRARY_PATTERN.test(libraryName)) {
      const parsed = safeManifest(raw, { legacy: true });
      return parsed?.libraryId === libraryName ? parsed : null;
    }
    // 迁移在「目录已改名、manifest 还没重写」之间中断过：按迁移规则补完。
    if (LEGACY_LIBRARY_PATTERN.test(String(raw?.libraryId ?? ''))) {
      const next = migratedManifest(raw, libraryName);
      const parsed = safeManifest(next);
      if (!parsed) return null;
      if (!config.readOnly) await atomicText(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
      return parsed;
    }
    const parsed = safeManifest(raw);
    return parsed?.libraryId === libraryName ? parsed : null;
  }

  async function loadManifests() {
    manifests.clear();
    let libraries = [];
    try { libraries = await fsp.readdir(config.mineruCacheDir, { withFileTypes: true }); } catch (error) {
      if (error.code !== 'ENOENT') logger.warn?.(`[pdf] 无法读取解析缓存：${error.message}`);
      return;
    }
    for (const libraryEntry of libraries) {
      if (!libraryEntry.isDirectory() || libraryEntry.isSymbolicLink()) continue;
      if (!LIBRARY_PATTERN.test(libraryEntry.name) && !LEGACY_LIBRARY_PATTERN.test(libraryEntry.name)) continue;
      let attachments = [];
      try {
        attachments = await fsp.readdir(path.join(config.mineruCacheDir, libraryEntry.name), { withFileTypes: true });
      } catch { continue; }
      for (const attachmentEntry of attachments) {
        if (!attachmentEntry.isDirectory() || attachmentEntry.isSymbolicLink() || !/^[A-Za-z0-9]+$/.test(attachmentEntry.name)) continue;
        try {
          const parsed = await readManifestEntry(libraryEntry.name, attachmentEntry.name);
          if (parsed) manifests.set(parsed.documentId, parsed);
        } catch (error) {
          logger.warn?.(`[pdf] 忽略损坏的解析任务 ${libraryEntry.name}/${attachmentEntry.name}：${error.message}`);
        }
      }
    }
    // 同一个附件既有旧目录又有新目录（别的设备已经迁移过）：以新目录为准，
    // 旧的不再加载，免得全文检索里同一篇出现两次。
    const modernKeys = new Set([...manifests.values()].filter(item => !item.legacy).map(item => item.attachmentKey));
    for (const [id, item] of manifests) {
      if (item.legacy && modernKeys.has(item.attachmentKey)) manifests.delete(id);
    }
  }

  /**
   * 把旧版本按本机 libraryID 存的缓存搬到全局库身份下。
   *
   * 靠附件 key 定位：key 是 Zotero 服务端分配的随机串，各设备一致，而本机编号
   * 不一致 —— 所以这台设备上 key 落在哪个库，就是它的全局身份，不需要知道
   * 当初写缓存的设备上那个编号指的是什么。key 在这台设备上找不到、或同时出现
   * 在多个库里时不动它，继续只读保留。
   *
   * 返回迁移成功的新 manifest，由调用方决定要不要重建索引、恢复任务。
   */
  async function migrateLegacyCaches(libraryData) {
    const pending = [...manifests.values()].filter(item => item.legacy);
    if (config.readOnly || !libraryData?.available || pending.length === 0) return [];

    const librariesByKey = new Map();
    for (const attachment of [...(libraryData.attachments || []), ...(libraryData.trashedAttachments || [])]) {
      const libraryId = String(attachment?.libraryId ?? '');
      if (!LIBRARY_PATTERN.test(libraryId)) continue;
      const candidates = librariesByKey.get(String(attachment.attachmentKey)) || new Set();
      candidates.add(libraryId);
      librariesByKey.set(String(attachment.attachmentKey), candidates);
    }

    const migrated = [];
    for (const legacy of pending) {
      if (stopping) break;
      if (manifests.get(legacy.documentId) !== legacy) continue;
      const candidates = librariesByKey.get(legacy.attachmentKey);
      if (!candidates || candidates.size !== 1) continue;
      const [libraryId] = candidates;
      const from = pathsFor(legacy);
      const to = pathsFor({ libraryId, attachmentKey: legacy.attachmentKey });
      try {
        const targetExists = await fsp.lstat(to.directory).then(() => true, error => {
          if (error.code === 'ENOENT') return false;
          throw error;
        });
        if (targetExists) {
          logger.warn?.(`[pdf] ${libraryId}/${legacy.attachmentKey} 已存在，旧缓存 ${legacy.libraryId}/${legacy.attachmentKey} 保留未迁移。`);
          continue;
        }
        const next = migratedManifest(JSON.parse(await fsp.readFile(from.manifest, 'utf8')), libraryId);
        const parsed = safeManifest(next);
        if (!parsed) continue;
        await ensureSafeTargetParent(config.vaultDir, to.directory, { create: true });
        await replaceFile(from.directory, to.directory);
        await atomicText(to.manifest, `${JSON.stringify(next, null, 2)}\n`);
        manifests.delete(legacy.documentId);
        db.removePdfDocument(legacy.documentId);
        manifests.set(parsed.documentId, parsed);
        migrated.push(parsed);
        await fsp.rmdir(path.dirname(from.directory)).catch(() => {});
      } catch (error) {
        logger.warn?.(`[pdf] 迁移旧缓存 ${legacy.libraryId}/${legacy.attachmentKey} 失败：${safeMessage(error.message)}`);
      }
    }
    if (migrated.length) logger.log?.(`[pdf] 已把 ${migrated.length} 份旧版 PDF 解析缓存迁移到全局库身份下`);
    return migrated;
  }

  // 迁移会移动目录、改写 manifest，同一时刻只能有一轮。
  let migration = Promise.resolve([]);
  function migrateSerially(libraryData) {
    const result = migration.then(() => migrateLegacyCaches(libraryData));
    migration = result.catch(() => []);
    return result;
  }

  /**
   * 从磁盘重读一份 manifest。
   *
   * manifests 是启动时读进来的快照；之后 Git 拉下来的别的设备的改动（刚开始的
   * 解析、刚完成的解析）不会自己出现在内存里。显式操作（enqueue）前按磁盘为准，
   * 否则就会拿过期的状态去覆盖别的设备刚写的 manifest，重复上传、重复计费。
   * 磁盘上的 updatedAt 和内存不一样才替换：内存里只改了状态、没落盘的标记
   * （见 reconcile 对非本机缓存的处理）保持不动。
   */
  async function reloadManifest(identity) {
    let parsed;
    try {
      parsed = safeManifest(JSON.parse(await fsp.readFile(pathsFor(identity).manifest, 'utf8')));
    } catch {
      return manifests.get(documentId(identity.libraryId, identity.attachmentKey)) || null;
    }
    if (!parsed) return manifests.get(documentId(identity.libraryId, identity.attachmentKey)) || null;
    const current = manifests.get(parsed.documentId);
    if (!current || current.updatedAt !== parsed.updatedAt) manifests.set(parsed.documentId, parsed);
    return manifests.get(parsed.documentId);
  }

  async function indexManifest(manifest) {
    const targets = pathsFor(manifest);
    const parsed = JSON.parse(await fsp.readFile(targets.contentList, 'utf8'));
    const normalized = parseContent(parsed);
    if (normalized.skippedBlocks) {
      // 静默丢正文是最难发现的那类问题，至少要在日志里留一行。
      logger.warn?.(
        `[pdf] ${manifest.documentId} 有 ${normalized.skippedBlocks} 个正文块缺少可靠页码，已跳过。`
      );
    }
    db.replacePdfDocument({
      documentId: manifest.documentId,
      libraryId: manifest.libraryId,
      attachmentKey: manifest.attachmentKey,
      parentKey: manifest.parentKey,
      title: manifest.title || manifest.fileName,
      fileName: manifest.fileName,
      sourceSha256: manifest.source.sha256,
      cachePath: toRelative(config.vaultDir, targets.directory),
      pageCount: normalized.pageCount,
      indexedAt: nowIso(),
      titleTokens: tokenizeToText(manifest.title || manifest.fileName),
      chunks: normalized.chunks
    });
    return normalized;
  }

  async function publishArtifacts(manifest, artifacts) {
    const targets = await ensureDirectory(manifest);
    await atomicText(targets.markdown, artifacts.markdown);
    await atomicText(targets.contentList, artifacts.contentListText);
  }

  async function copyReadyArtifacts(source, target) {
    const sourcePaths = pathsFor(source);
    const markdown = await fsp.readFile(sourcePaths.markdown, 'utf8');
    const contentListText = await fsp.readFile(sourcePaths.contentList, 'utf8');
    const contentList = JSON.parse(contentListText);
    parseContent(contentList);
    await publishArtifacts(target, { markdown, contentListText });
  }

  function findDuplicate(sha256, excludingDocumentId) {
    return [...manifests.values()].find(candidate => (
      candidate.documentId !== excludingDocumentId
      && candidate.state === 'ready'
      && candidate.parseProfile === PARSE_PROFILE
      && candidate.source?.sha256 === sha256
    ));
  }

  async function copyAndHash(opened, targetPath, signal) {
    if (opened.stats.size > MAX_PDF_BYTES) throw new Error('PDF 必须小于等于 200 MB。');
    const before = opened.stats;
    const hash = crypto.createHash('sha256');
    let size = 0;
    const digest = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      }
    });
    await pipeline(
      opened.handle.createReadStream({ autoClose: false, start: 0 }),
      digest,
      fs.createWriteStream(targetPath, { flags: 'wx' }),
      { signal }
    );
    const after = await opened.handle.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('Zotero PDF 在读取期间发生变化，请重试。');
    }
    return { sha256: hash.digest('hex'), size, mtimeMs: before.mtimeMs };
  }

  async function resolveTrustedAttachment(manifest) {
    const library = await readLibraryData(config.zoteroDataDir);
    if (!library.available) throw new Error(library.reason);
    const matched = library.attachments.find(attachment => (
      String(attachment.libraryId) === manifest.libraryId
      && attachment.attachmentKey === manifest.attachmentKey
    ));
    if (!matched) throw new Error('在当前 Zotero 数据库中找不到这个 PDF 附件。');
    return matched;
  }

  async function finishRemote(manifest, signal, temporaryDir) {
    let next = manifest;
    const result = await mineru.waitForResult(next.batchId, {
      signal,
      onProgress: async status => {
        const state = status.state === 'done'
          ? 'downloading'
          : status.state === 'pending'
            ? 'pending'
            : 'running';
        // manifest.json 在纳入 Git 的目录里。进度没变还每轮写一次，只会给
        // 同步制造一串无意义的改动。
        const unchanged = next.state === state
          && !next.error
          && (next.progress?.extractedPages ?? null) === (status.progress?.extractedPages ?? null)
          && (next.progress?.totalPages ?? null) === (status.progress?.totalPages ?? null);
        if (unchanged) return;
        next = await saveManifest({
          ...next,
          state,
          progress: status.progress,
          error: ''
        });
      }
    });
    next = await saveManifest({ ...next, state: 'downloading', progress: result.progress, error: '' });
    const zipPath = path.join(temporaryDir, 'result.zip');
    await mineru.downloadResult({ zipUrl: result.zipUrl, targetPath: zipPath, signal });
    const artifacts = await readArchive(zipPath);
    const normalized = parseContent(artifacts.contentList);
    await publishArtifacts(next, artifacts);
    next = await saveManifest({ ...next, state: 'indexing', pageCount: normalized.pageCount, error: '' });
    await indexManifest(next);
    return saveManifest({ ...next, state: 'ready', pageCount: normalized.pageCount, progress: null, error: '' });
  }

  async function processJob(id) {
    let manifest = manifests.get(id);
    if (!manifest || stopping) return;
    if (busy.has(id)) {
      // 排到队里的任务状态一定是 active，而对账只碰非 active 的文档 —— 走到
      // 这里说明互斥的前提被改坏了，宁可吵一声也不要静默丢任务。
      logger.warn?.(`[pdf] 任务 ${id} 排到时仍被占用，已跳过。`);
      return;
    }
    busy.add(id);
    const controller = new AbortController();
    activeController = controller;
    let temporaryDir = '';
    try {
      // mkdtemp 原来在 try 外面。加了 busy 之后这就是一把会漏的锁：临时目录
      // 建不出来（磁盘满、TMPDIR 不存在）就永久占住这篇，重试全被挡死。
      temporaryDir = await fsp.mkdtemp(path.join(os.tmpdir(), `workstation-mineru-${process.pid}-`));
      if (manifest.state === 'indexing') {
        const normalized = await indexManifest(manifest);
        await saveManifest({ ...manifest, state: 'ready', pageCount: normalized.pageCount, progress: null, error: '' });
        return;
      }
      if (manifest.batchId && (
        RECOVERABLE_WITH_BATCH.has(manifest.state)
        || (manifest.state === 'queued' && manifest.submissionConfirmed)
      )) {
        manifest = await saveManifest({ ...manifest, state: 'submitted', error: '' });
        await finishRemote(manifest, controller.signal, temporaryDir);
        return;
      }

      const attachment = await resolveTrustedAttachment(manifest);
      const opened = await openAttachmentPdf(config.zoteroDataDir, attachment);
      const pdfPath = path.join(temporaryDir, 'source.pdf');
      try {
        manifest = await saveManifest({
          ...manifest,
          state: 'preparing',
          fileName: opened.fileName,
          storagePath: attachment.storagePath,
          parentKey: attachment.parentKey || '',
          title: attachment.parentTitle || opened.fileName,
          error: '',
          progress: null
        });
        const source = await copyAndHash(opened, pdfPath, controller.signal);
        manifest = await saveManifest({ ...manifest, source });
      } finally {
        await opened.handle.close().catch(() => {});
      }

      const duplicate = findDuplicate(manifest.source.sha256, manifest.documentId);
      if (duplicate) {
        await copyReadyArtifacts(duplicate, manifest);
        manifest = await saveManifest({ ...manifest, state: 'indexing' });
        const normalized = await indexManifest(manifest);
        await saveManifest({
          ...manifest,
          state: 'ready',
          pageCount: normalized.pageCount,
          progress: null,
          error: '',
          reusedFrom: duplicate.documentId
        });
        return;
      }

      const remote = await mineru.createTask({
        fileName: manifest.fileName,
        dataId: manifest.documentId,
        signal: controller.signal
      });
      manifest = await saveManifest({
        ...manifest,
        state: 'uploading',
        batchId: remote.batchId,
        error: ''
      });
      await mineru.uploadFile({
        uploadUrl: remote.uploadUrl,
        filePath: pdfPath,
        size: manifest.source.size,
        signal: controller.signal
      });
      manifest = await saveManifest({
        ...manifest,
        state: 'submitted',
        submissionConfirmed: true,
        error: ''
      });
      await finishRemote(manifest, controller.signal, temporaryDir);
    } catch (error) {
      if (error.name !== 'AbortError' && !stopping) {
        const latest = manifests.get(id) || manifest;
        await saveManifest({
          ...latest,
          state: 'failed',
          error: safeMessage(error.message),
          progress: null
        }).catch(writeError => logger.warn?.(`[pdf] 无法保存失败状态：${writeError.message}`));
      }
    } finally {
      if (activeController === controller) activeController = null;
      busy.delete(id);
      if (temporaryDir) await fsp.rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  function schedule(id) {
    if (stopping || scheduled.has(id)) return;
    scheduled.add(id);
    const operation = queue.then(() => processJob(id));
    queue = operation.catch(error => logger.warn?.(`[pdf] 解析任务失败：${safeMessage(error.message)}`))
      .finally(() => scheduled.delete(id));
  }

  /**
   * 按 manifest 的状态恢复它：ready 的建进派生索引，中断的任务续跑或标失败。
   * 返回是否已建好索引。启动时对每一份调用，迁移出来的新 manifest 也走这里。
   */
  async function activate(manifest) {
    if (manifest.state === 'ready') {
      try {
        await indexManifest(manifest);
        return true;
      } catch (error) {
        logger.warn?.(`[pdf] 无法重建 ${manifest.documentId} 的索引：${error.message}`);
        const failed = {
          ...manifest,
          state: 'failed',
          error: '本地 PDF 解析缓存损坏，请重试。',
          progress: null
        };
        if (config.readOnly || manifest.legacy || ownedElsewhere(manifest)) manifests.set(manifest.documentId, failed);
        else await saveManifest(failed);
        return false;
      }
    }
    // 旧目录下的缓存只读：只提供已经解析好的正文，不续跑、不改状态。
    if (manifest.legacy || ownedElsewhere(manifest)) return false;
    if (!config.readOnly && manifest.state === 'indexing') {
      schedule(manifest.documentId);
    } else if (!config.readOnly && (
      manifest.state === 'queued'
      || (manifest.batchId && RECOVERABLE_WITH_BATCH.has(manifest.state))
    )) {
      schedule(manifest.documentId);
    } else if (!config.readOnly && ACTIVE_STATES.has(manifest.state)) {
      await saveManifest({
        ...manifest,
        state: 'failed',
        error: '上次解析在提交至 MinerU 前中断，请重试。',
        progress: null
      });
    }
    return false;
  }

  // 启动时有旧缓存才去读 Zotero：迁移需要知道每个附件 key 在这台设备上
  // 属于哪个库。没配 Zotero 或读不到就先只读保留，下次打开文献页再迁。
  async function migrateAtStartup() {
    if (config.readOnly || !config.zoteroDataDir) return;
    if (![...manifests.values()].some(item => item.legacy)) return;
    try {
      await migrateSerially(await readLibraryData(config.zoteroDataDir));
    } catch (error) {
      logger.warn?.(`[pdf] 启动时迁移旧缓存失败：${safeMessage(error.message)}`);
    }
  }

  function initialize() {
    if (initialization) return initialization;
    initialization = (async () => {
      await loadManifests();
      await migrateAtStartup();
      const ready = new Set();
      for (const manifest of [...manifests.values()]) {
        if (await activate(manifest)) ready.add(manifest.documentId);
      }
      for (const indexed of db.listPdfDocuments()) {
        if (!ready.has(indexed.documentId)) db.removePdfDocument(indexed.documentId);
      }
      return { manifests: manifests.size, ready: ready.size };
    })();
    return initialization;
  }

  async function removeManifest(manifest) {
    db.removePdfDocument(manifest.documentId);
    manifests.delete(manifest.documentId);
    await fsp.rm(pathsFor(manifest).directory, { recursive: true, force: true });
  }

  async function hashCurrentAttachment(attachment) {
    const opened = await openAttachmentPdf(config.zoteroDataDir, attachment);
    try {
      const before = opened.stats;
      const hash = crypto.createHash('sha256');
      let size = 0;
      await pipeline(opened.handle.createReadStream({ autoClose: false, start: 0 }), new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          hash.update(chunk);
          callback();
        }
      }));
      const after = await opened.handle.stat();
      if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new Error('Zotero PDF 在读取期间发生变化，请重试。');
      }
      return { sha256: hash.digest('hex'), size, mtimeMs: before.mtimeMs };
    } finally {
      await opened.handle.close().catch(() => {});
    }
  }

  async function currentSource(manifest, attachment, inspected) {
    if (!manifest.source?.sha256 || inspected.size !== manifest.source.size) {
      return { matches: false, source: null };
    }
    if (inspected.mtimeMs === manifest.source.mtimeMs) {
      return { matches: true, source: manifest.source };
    }
    const source = await hashCurrentAttachment(attachment);
    return { matches: source.sha256 === manifest.source.sha256, source };
  }

  function safeIdentityKey(attachment) {
    try {
      return identityKey(attachment?.libraryId, attachment?.attachmentKey);
    } catch {
      // 身份不合法的附件既建不出缓存路径也生成不了 documentId，跳过就是了 ——
      // 不该让一条脏记录把整个文献页打成 500。
      return '';
    }
  }

  async function mapWithLimit(items, limit, mapper) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index], index);
      }
    });
    await Promise.all(workers);
    return results;
  }

  /**
   * 把本地缓存和 Zotero 的最新快照对齐。
   *
   * 这里每一步都在删用户重新解析才能拿回来的东西，所以判据要写死：
   *
   *   1. **不拿比 manifest 更旧的库快照做删除决策。** 对账一轮可以跑几分钟，
   *      期间用户完全可能对某篇点了重新解析并跑完；那份 manifest 依据的是
   *      比 `readAt` 更新的信息，这时候再按旧快照说「Zotero 里没有这篇」把它
   *      删掉，就是拿过期情报销毁刚产生的结果。只重读 manifest 不够 —— 重读
   *      看到的是 ready，照样会删。必须比时间。
   *   2. 只处理没被别人占用的文档（busy），且落盘前重新取一遍 manifest。
   *   3. 回收站里的附件只是软删除，不动它的缓存。
   *   4. 只清理归属本机的缓存（见 ownedHere），且库为空、key 在别的库里、
   *      或一轮要删的比例异常时一律不删。
   *   5. 一次最多重新哈希 MAX_REHASH_PER_PASS 篇（且只有真的哈希成功才算数），
   *      剩下的留给下次页面加载，免得 Zotero 成批刷新 mtime 之后一个 GET
   *      请求要读几个 GB。
   */
  async function reconcile(libraryData, attachmentMap, inspections, observedAt) {
    const trashed = new Set();
    // 附件 key 在 Zotero 里是全局随机串，libraryId 却只在本机有效：同一个群组库
    // 在另一台设备上换了编号时，key 还是那个 key。任何库里还有这个 key，就不算删除。
    const knownKeys = new Set();
    const populatedLibraries = new Set();
    for (const attachment of libraryData.trashedAttachments || []) {
      const key = safeIdentityKey(attachment);
      if (!key) continue;
      trashed.add(key);
      knownKeys.add(String(attachment.attachmentKey));
      populatedLibraries.add(String(attachment.libraryId));
    }
    for (const attachment of attachmentMap.values()) {
      knownKeys.add(String(attachment.attachmentKey));
      populatedLibraries.add(String(attachment.libraryId));
    }
    const snapshotAt = Number(libraryData.readAt) || observedAt;

    // 只留 id：循环里每一步都必须看 manifests 里的当前值，绝不能用开循环时
    // 那份快照对象 —— 前面几篇的 await 期间它可能已经完全变了。
    function actionable(id) {
      const latest = manifests.get(id);
      // 旧目录下的缓存还没迁移，身份和这份快照对不上，对账一律不碰。
      if (!latest || latest.legacy || ACTIVE_STATES.has(latest.state)) return null;
      if (Date.parse(latest.updatedAt || '') > snapshotAt) return null;
      return latest;
    }

    // 「附件已被删除」必须同时满足：归属本机、快照里这个库确实有内容（一个完全
    // 空的库更像是选错了数据目录或同步还没跑完）、任何库里都找不到这个 key。
    function removalCandidate(manifest) {
      if (!ownedHere(manifest)) return false;
      const key = identityKey(manifest.libraryId, manifest.attachmentKey);
      if (attachmentMap.has(key) || trashed.has(key)) return false;
      if (knownKeys.has(manifest.attachmentKey)) return false;
      return populatedLibraries.has(manifest.libraryId);
    }

    const owned = [...manifests.values()].filter(manifest => !manifest.legacy && ownedHere(manifest));
    const candidates = owned.filter(manifest => actionable(manifest.documentId) && removalCandidate(manifest));
    const massRemoval = candidates.length > MASS_REMOVAL_MIN
      && candidates.length > owned.length * MASS_REMOVAL_RATIO;
    if (massRemoval) {
      logger.warn?.(
        `[pdf] 本轮对账有 ${candidates.length} 篇解析缓存对应的 Zotero 附件不在快照里，`
        + '比例异常（多半是 Zotero 还没同步完或数据目录选错），本轮全部保留。'
        + '若确实删除了这些文献，需要手工删除 .workstation/mineru/ 下对应的目录。'
      );
    }

    let rehashBudget = MAX_REHASH_PER_PASS;
    for (const id of [...manifests.keys()]) {
      if (stopping) return;
      if (busy.has(id)) continue;
      const current = actionable(id);
      if (!current) continue;
      const key = identityKey(current.libraryId, current.attachmentKey);
      const attachment = attachmentMap.get(key);

      if (!attachment) {
        if (massRemoval || !removalCandidate(current)) continue;
        busy.add(id);
        try {
          const latest = actionable(id);
          if (latest && removalCandidate(latest) && !stopping) await removeManifest(latest);
        } catch (error) {
          logger.warn?.(`[pdf] 清理 ${id} 的缓存失败：${error.message}`);
        } finally {
          busy.delete(id);
        }
        continue;
      }

      if (!current.source?.sha256) continue;
      const inspected = inspections.get(key);
      if (!inspected?.available) continue;
      if (inspected.size === current.source.size && inspected.mtimeMs === current.source.mtimeMs) continue;
      if (rehashBudget <= 0) continue;

      busy.add(id);
      try {
        const source = await hashCurrentAttachment(attachment);
        // 只有真的读完一遍才扣预算。放在 try 外面的话，一批读不了的文件
        // （Zotero 正在写它们）会把每轮的名额全烧光，后面的文献永远轮不到。
        rehashBudget -= 1;
        const latest = actionable(id);
        if (!latest || !latest.source?.sha256 || stopping) continue;
        if (ownedHere(latest)) {
          if (source.sha256 !== latest.source.sha256) await removeManifest(latest);
          else await saveManifest({ ...latest, source });
        } else if (source.sha256 !== latest.source.sha256) {
          // 不归本机的缓存（别的设备建的、或旧版本没记归属的）不删磁盘目录，
          // 也不改写 manifest：别的设备上 Zotero 的文件可能只是还没同步到新版本。
          // 但这台机器上的 PDF 确实已经不是解析时那一份，旧正文不能继续冒充它 ——
          // 只在本机把它标成失效，并撤掉派生索引，等用户重新解析。
          db.removePdfDocument(id);
          manifests.set(id, {
            ...latest,
            state: 'failed',
            error: '本机 Zotero 中的 PDF 已替换，解析结果已过期，请重新解析。',
            progress: null
          });
        } else {
          // 内容相同，只是本机文件的 mtime 不一样：记在内存里省得每次都重新哈希，
          // 但不写回别的设备的 manifest，免得两台机器轮流改它制造 Git 冲突。
          manifests.set(id, { ...latest, source });
        }
      } catch (error) {
        logger.warn?.(`[pdf] 对账 ${id} 失败：${safeMessage(error.message)}`);
      } finally {
        busy.delete(id);
      }
    }
  }

  async function describeLibrary(libraryData) {
    await initialize();
    if (!libraryData.available) return [];

    if (!config.readOnly) {
      for (const migrated of await migrateSerially(libraryData)) await activate(migrated);
    }

    const observedAt = Date.now();
    const attachments = libraryData.attachments.filter(attachment => safeIdentityKey(attachment));
    // 每个附件只 inspect 一遍（对账和渲染共用），并限制并发：一遍是 3 次 lstat
    // + 2 次 realpath + open + 读魔数，几千个附件全并发会顶满文件句柄。
    const inspected = await mapWithLimit(
      attachments,
      INSPECT_CONCURRENCY,
      attachment => inspectAttachmentPdf(config.zoteroDataDir, attachment)
    );
    const attachmentMap = new Map();
    const inspections = new Map();
    for (const [index, attachment] of attachments.entries()) {
      const key = safeIdentityKey(attachment);
      attachmentMap.set(key, attachment);
      inspections.set(key, inspected[index]);
    }

    if (!config.readOnly) {
      // 挂到 reconciling 上，stop() 才等得到它 —— 否则退出流程走完之后，
      // 一轮还没结束的对账仍会继续删东西。
      reconciling = reconcile(libraryData, attachmentMap, inspections, observedAt)
        .catch(error => logger.warn?.(`[pdf] 对账中断：${safeMessage(error.message)}`));
      await reconciling;
    }

    return attachments.map((attachment, index) => {
      const id = documentId(attachment.libraryId, attachment.attachmentKey);
      const status = inspected[index];
      return {
        ...attachment,
        documentId: id,
        fileName: status.fileName,
        localAvailable: status.available,
        unavailableReason: status.available ? '' : status.reason,
        size: status.size || 0,
        mtimeMs: status.mtimeMs || 0,
        tokenConfigured: mineru.configured(),
        ...publicStatus(manifests.get(id))
      };
    });
  }

  async function enqueue({ libraryId, attachmentKey }) {
    await initialize();
    if (config.readOnly) throw new Error('只读模式不能解析 PDF。');
    if (!mineru.configured()) throw new Error('请先在应用设置中配置 MinerU API Token。');
    const identity = validateIdentity(libraryId, attachmentKey);
    const library = await readLibraryData(config.zoteroDataDir);
    if (!library.available) throw new Error(library.reason);
    const attachment = library.attachments.find(candidate => (
      String(candidate.libraryId) === identity.libraryId
      && candidate.attachmentKey === identity.attachmentKey
    ));
    if (!attachment) throw new Error('在当前 Zotero 数据库中找不到这个 PDF 附件。');
    const inspected = await inspectAttachmentPdf(config.zoteroDataDir, attachment);
    if (!inspected.available) throw new Error(inspected.reason);

    const id = documentId(identity.libraryId, identity.attachmentKey);
    // 对账正在核对这篇（或后台任务正在跑）：不和它抢着改 manifest。
    //
    // 这里必须报错而不是回一个当前状态：回状态的话路由照样是 202 + ok:true，
    // 前端先弹「已加入解析队列」，紧接着轮询读到 ready 又弹「解析完成」并刷新
    // 页面 —— 用户点了重新解析，收到两条成功提示，实际什么都没发生。
    if (busy.has(id)) throw new Error('Zotero PDF 正在核对或处理中，请稍后重试。');

    busy.add(id);
    let queued = null;
    try {
      const existing = await reloadManifest(identity);
      if (existing && ACTIVE_STATES.has(existing.state) && ownedElsewhere(existing) && !abandonedElsewhere(existing)) {
        // 回一个当前状态的话，前端会提示「已加入解析队列」，而本机其实什么都没做。
        const error = new Error(`Zotero PDF 正在设备「${existing.ownerDevice}」上解析，请等那边完成后再试。`);
        error.status = 409;
        throw error;
      }
      if (existing && ACTIVE_STATES.has(existing.state) && !abandonedElsewhere(existing)) {
        return publicStatus(existing);
      }
      if (existing?.state === 'ready') {
        const current = await currentSource(existing, attachment, inspected);
        if (current.matches) {
          let ready = existing;
          if (current.source !== existing.source) {
            // 别的设备的 manifest 只在内存里更新本机的 mtime，理由同 reconcile。
            if (ownedElsewhere(existing)) {
              ready = { ...existing, source: current.source };
              manifests.set(id, ready);
            } else {
              ready = await saveManifest({ ...existing, source: current.source });
            }
          }
          // 刚经 Git 拉下来的 ready 缓存还没进本机的派生索引。
          if (!db.getPdfDocument(id)) await indexManifest(ready);
          return publicStatus(ready);
        }
        await removeManifest(existing);
      }

      let reusable = false;
      let source = null;
      if (existing?.state === 'failed' && existing.submissionConfirmed && existing.batchId) {
        const current = await currentSource(existing, attachment, inspected);
        reusable = current.matches;
        source = current.source;
      }

      queued = await saveManifest({
        version: MANIFEST_VERSION,
        parseProfile: PARSE_PROFILE,
        documentId: id,
        ...identity,
        parentKey: attachment.parentKey || '',
        title: attachment.parentTitle || inspected.fileName,
        fileName: inspected.fileName,
        storagePath: attachment.storagePath,
        state: 'queued',
        // 显式发起（或重新发起）解析的设备就是这份缓存的归属设备。
        ownerDevice: device,
        batchId: reusable ? existing.batchId : '',
        submissionConfirmed: reusable,
        progress: null,
        source: reusable ? source : null,
        pageCount: 0,
        error: '',
        createdAt: existing?.createdAt || nowIso()
      });
    } finally {
      busy.delete(id);
    }
    // schedule 放在临界区外：processJob 一开始就要抢同一把锁。
    schedule(id);
    return publicStatus(queued);
  }

  function status(id) {
    if (!/^[a-f0-9]{32}$/.test(String(id || ''))) return null;
    const manifest = manifests.get(String(id));
    return manifest ? publicStatus(manifest) : null;
  }

  function preview(id, { chunkIndex } = {}) {
    const document = db.getPdfDocument(id);
    if (!document) return null;
    const all = db.listPdfChunks(id);
    if (!all.length) return null;
    const requested = Number(chunkIndex);
    const selected = Number.isInteger(requested)
      ? all.find(chunk => chunk.chunkIndex === requested) || all[0]
      : all[0];
    const chunks = all.filter(chunk => chunk.pageIndex === selected.pageIndex);
    // 按页码排序而不是按出现顺序：MinerU 的阅读序偶尔会回跳（脚注、跨栏），
    // 那时「上一页 / 下一页」会带着用户在页码之间来回蹦。
    const pages = [...new Set(all.map(chunk => chunk.pageIndex))].sort((a, b) => a - b);
    const position = pages.indexOf(selected.pageIndex);
    return {
      document,
      chunks,
      selectedChunk: selected.chunkIndex,
      pageIndex: selected.pageIndex,
      pageNumber: selected.pageIndex + 1,
      previousChunk: position > 0
        ? all.find(chunk => chunk.pageIndex === pages[position - 1])?.chunkIndex ?? null
        : null,
      nextChunk: position < pages.length - 1
        ? all.find(chunk => chunk.pageIndex === pages[position + 1])?.chunkIndex ?? null
        : null
    };
  }

  async function stop() {
    stopping = true;
    activeController?.abort();
    await initialization?.catch(() => {});
    // 迁移在搬目录、改 manifest，一份一份很快，但不能在中间被退出打断。
    await migration.catch(() => {});
    await queue;
    // 对账不走任务队列（它不能被一个几分钟的解析挡住），所以要单独等一次，
    // 否则 stop() 返回之后它还会接着删缓存、写 manifest。
    //
    // 但不能无限期等：它可能正卡在一次读不动的文件上（网络盘、被独占的
    // 附件），那样退出流程就永远走不完。给个上限即可 —— 每个删除/写入动作
    // 前面都会再看一眼 stopping，超时之后它也不会再改任何东西。
    await Promise.race([
      reconciling,
      new Promise(resolve => {
        const timer = setTimeout(resolve, STOP_RECONCILE_GRACE_MS);
        timer.unref?.();
      })
    ]);
  }

  return {
    initialize,
    ready: initialize,
    // 某篇文献是否正被解析任务、enqueue 或对账独占。只读，用来观测互斥是否生效。
    isBusy: id => busy.has(String(id || '')),
    describeLibrary,
    enqueue,
    status,
    preview,
    stop,
    idle: () => queue,
    documentId,
    publicStatus
  };
}

module.exports = {
  createPdfLibraryService,
  documentId,
  validateIdentity,
  publicStatus,
  PARSE_PROFILE,
  MANIFEST_VERSION,
  ACTIVE_STATES
};
