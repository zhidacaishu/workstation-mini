const express = require('express');
const zotero = require('../integrations/zotero');
const { createJournalTracker } = require('../integrations/journalTracker');
const { readNote, writeNote } = require('../vault/note');
const { renderMarkdown } = require('../markdown');
const { enqueueNote } = require('../vault/note-queue');
const { isSafeRelativePath, toPosix } = require('../vault/paths');
const {
  parseManagedAnnotations,
  processAnnotation,
  renderLiteratureNote,
  syncLiteratureNote
} = require('../annotations');

const { httpError, blockWhenReadOnly } = require('./http');

const CLIPS_SECTION = 'clips';

function text(value, label, max, { required = false } = {}) {
  const result = String(value || '').trim();
  if (required && !result) throw httpError(400, `${label}不能为空。`);
  if (result.length > max) throw httpError(400, `${label}不能超过 ${max} 个字符。`);
  return result;
}

function zoteroKey(value) {
  const key = text(value, 'Zotero key', 64, { required: true });
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw httpError(400, 'Zotero key 格式无效。');
  return key;
}

function pdfDocumentId(value) {
  const id = text(value, 'PDF 文档 ID', 32, { required: true });
  if (!/^[a-f0-9]{32}$/.test(id)) throw httpError(400, 'PDF 文档 ID 格式无效。');
  return id;
}

function pdfChunkIndex(value) {
  if (value === undefined || value === '') return undefined;
  if (!/^\d{1,9}$/.test(String(value))) throw httpError(400, 'PDF 正文位置无效。');
  return Number(value);
}

function pdfRequestError(error) {
  if (error?.status) return error;
  const message = String(error?.message || '');
  const allowed = [
    '请先在应用设置中配置 MinerU',
    '在当前 Zotero 数据库中找不到',
    'PDF 尚未下载到本机',
    'PDF 必须小于等于',
    'Zotero PDF',
    'Zotero 附件',
    '只读模式不能解析 PDF'
  ];
  if (allowed.some(prefix => message.startsWith(prefix))) {
    return httpError(400, message.slice(0, 300));
  }
  return httpError(500, '无法读取或排队解析这个 PDF。');
}

function fileSizeLabel(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function pdfView(attachment) {
  const labels = {
    unparsed: '尚未解析',
    queued: '等待解析',
    preparing: '准备文件',
    uploading: '正在上传',
    submitted: '已提交',
    pending: '等待 MinerU',
    running: 'MinerU 解析中',
    downloading: '下载结果',
    indexing: '建立索引',
    ready: '可以检索',
    failed: '解析失败'
  };
  const state = labels[attachment.state] ? attachment.state : 'unparsed';
  const progress = attachment.progress;
  const progressLabel = progress?.totalPages > 0
    ? `${Math.min(progress.extractedPages, progress.totalPages)} / ${progress.totalPages} 页`
    : '';
  return {
    documentId: attachment.documentId,
    libraryId: String(attachment.libraryId),
    attachmentKey: attachment.attachmentKey,
    parentKey: attachment.parentKey || '',
    parentTitle: attachment.parentTitle || '',
    fileName: attachment.fileName || 'PDF 附件',
    localAvailable: Boolean(attachment.localAvailable),
    unavailableReason: attachment.unavailableReason || '',
    tokenConfigured: Boolean(attachment.tokenConfigured),
    pageCount: Number(attachment.pageCount) || 0,
    error: attachment.error || '',
    state,
    stateLabel: labels[state],
    progressLabel,
    sizeLabel: attachment.localAvailable ? fileSizeLabel(attachment.size) : '',
    active: ['queued', 'preparing', 'uploading', 'submitted', 'pending', 'running', 'downloading', 'indexing'].includes(state)
  };
}

function processingPayload(body = {}) {
  const requested = body.outputs && typeof body.outputs === 'object' && !Array.isArray(body.outputs)
    ? body.outputs
    : {};
  const outputs = {};
  if (requested.note) {
    outputs.note = {
      title: text(requested.note.title, '永久笔记标题', 200, { required: true }),
      body: text(requested.note.body, '永久笔记正文', 20_000, { required: true })
    };
  }
  if (requested.card) {
    const deckFile = text(requested.card.deckFile || 'inbox', '卡组', 100, { required: true })
      .replace(/\.md$/i, '');
    // 和 /cards/add、/api/cards/accept 用同一把尺子。原来这里是自己写的正则，
    // 放行了 con/aux/nul/COM1 这些 Windows 设备名，以及 `/etc/x`、`a//b` 这类
    // 非规范写法 —— 逃不出 vault（path.join 会归一化），但没有理由比另外两个入口松。
    if (!isSafeRelativePath(`cards/${deckFile}.md`)) throw httpError(400, '卡组名称无效。');
    outputs.card = {
      deckFile,
      front: text(requested.card.front, '卡片正面', 500, { required: true }),
      back: text(requested.card.back, '卡片背面', 10_000, { required: true })
    };
  }
  if (requested.task) {
    outputs.task = { title: text(requested.task.title, '待办内容', 500, { required: true }) };
  }
  return {
    notePath: text(body.notePath, '文献笔记路径', 500, { required: true }),
    annotationId: text(body.annotationId, '标注 ID', 200, { required: true }),
    expectedHash: text(body.expectedHash, '笔记版本', 128),
    outputs
  };
}

function createIntegrationRoutes({ config, db, indexer, pdfService, pdfSearch }) {
  const router = express.Router();
  const tracker = createJournalTracker({
    baseUrl: config.journalTrackerUrl,
    email: config.journalTrackerEmail,
    password: config.journalTrackerPassword
  });

  const guard = blockWhenReadOnly(config, '不能写入。');
  const pdf = pdfService || {
    ready: async () => {},
    describeLibrary: async () => [],
    enqueue: async () => { throw httpError(503, 'PDF 解析服务尚未启动。'); },
    status: () => null,
    preview: () => null
  };
  const pdfLookup = pdfSearch || { search: query => ({ query, results: [], usedFallback: false }) };

  /** 文献入口：Zotero 题录 + 标注、journal-tracker 待读、剪藏收件箱。 */
  router.get('/library', async (req, res, next) => {
    try {
      const [items, libraryData, papers] = await Promise.all([
        zotero.fetchItems({ base: config.zoteroApi }),
        zotero.readLibraryData(config.zoteroDataDir),
        tracker.papers({ limit: 20 })
      ]);
      const pdfAttachments = await pdf.describeLibrary(libraryData);

      const existingRows = db.raw.prepare(`
        SELECT path, hash, data_json AS dataJson FROM notes WHERE section = 'lit'
      `).all();
      const existing = new Map(existingRows.map(row => {
        try {
          const data = JSON.parse(row.dataJson);
          return [data.zotero, {
            path: row.path,
            hash: row.hash,
            title: data.title || row.path,
            year: data.year ? String(data.year) : '',
            publication: data.publication || ''
          }];
        } catch { return [null, null]; }
      }).filter(([key]) => key));
      const counts = new Map(db.annotationCountsByItem().map(row => [row.itemKey, row]));
      const pendingAnnotations = [...existing.keys()].flatMap(itemKey => (
        db.listPendingAnnotations({ itemKey, limit: counts.get(itemKey)?.pending || 1 })
      ));
      const annotationDetails = new Map();
      await Promise.all([...new Set(pendingAnnotations.map(entry => entry.notePath))].map(async notePath => {
        // 索引里有、磁盘上没有是正常的中间态：文献笔记被外部删掉，而监听还没追上。
        // 这时候整页 500 掉毫无道理 —— 少一条标注详情而已，其余内容照常渲染。
        try {
          const note = await readNote(config.notesDir, notePath);
          for (const annotation of parseManagedAnnotations(note.body)) {
            annotationDetails.set(annotation.id, annotation);
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }));
      const pendingByItem = new Map();
      for (const annotation of pendingAnnotations) {
        const list = pendingByItem.get(annotation.itemKey) || [];
        list.push({ ...annotation, comment: annotationDetails.get(annotation.id)?.comment || '' });
        pendingByItem.set(annotation.itemKey, list);
      }

      const annotationsByKey = new Map(
        (libraryData.items || []).map(entry => [entry.key, entry.annotations])
      );

      const apiKeys = new Set((items.items || []).map(item => item.key));
      const itemsByKey = new Map((items.items || []).map(item => [item.key, item]));
      for (const [key, local] of existing) {
        if (!itemsByKey.has(key)) {
          itemsByKey.set(key, {
            key,
            title: local.title,
            year: local.year,
            publication: local.publication,
            creators: [],
            tags: []
          });
        }
      }

      const pdfsByParent = new Map();
      const standalonePdfs = [];
      for (const source of pdfAttachments) {
        const attachment = pdfView(source);
        if (!attachment.parentKey) {
          standalonePdfs.push(attachment);
          continue;
        }
        const attached = pdfsByParent.get(attachment.parentKey) || [];
        attached.push(attachment);
        pdfsByParent.set(attachment.parentKey, attached);
        if (!itemsByKey.has(attachment.parentKey)) {
          itemsByKey.set(attachment.parentKey, {
            key: attachment.parentKey,
            title: attachment.parentTitle || attachment.fileName,
            year: '',
            publication: '',
            creators: [],
            tags: []
          });
        }
      }

      const zoteroItems = [...itemsByKey.values()].map(item => ({
        ...item,
        standalone: false,
        canCreateNote: apiKeys.has(item.key),
        annotationCount: (annotationsByKey.get(item.key) || []).length,
        hasNote: existing.has(item.key),
        notePath: existing.get(item.key)?.path || '',
        noteHash: existing.get(item.key)?.hash || '',
        pendingCount: Number(counts.get(item.key)?.pending || 0),
        pendingAnnotations: pendingByItem.get(item.key) || [],
        pdfs: pdfsByParent.get(item.key) || []
      }));
      for (const attachment of standalonePdfs) {
        zoteroItems.push({
          key: `pdf-${attachment.documentId}`,
          title: attachment.fileName,
          year: '',
          publication: '',
          creators: [],
          tags: [],
          standalone: true,
          canCreateNote: false,
          annotationCount: 0,
          hasNote: false,
          notePath: '',
          noteHash: '',
          pendingCount: 0,
          pendingAnnotations: [],
          pdfs: [attachment]
        });
      }

      res.render('library', {
        title: '文献',
        zoteroItems,
        zoteroStatus: items.available ? '' : items.reason,
        annotationStatus: libraryData.available ? '' : libraryData.reason,
        annotationTotal: (libraryData.items || []).reduce((sum, entry) => sum + entry.annotations.length, 0),
        pdfTotal: pdfAttachments.length,
        pdfReadyTotal: pdfAttachments.filter(attachment => attachment.state === 'ready').length,
        papers: papers.papers || [],
        papersStatus: papers.available ? '' : papers.reason,
        clips: db.raw.prepare(`
          SELECT path, title_raw AS title, data_json AS dataJson FROM notes
          WHERE section = ? ORDER BY mtime_ms DESC LIMIT 30
        `).all(CLIPS_SECTION).map(row => {
          let data = {};
          try { data = JSON.parse(row.dataJson) || {}; } catch { data = {}; }
          return { path: row.path, title: row.title, source: data.source || '', status: data.status || '' };
        })
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/library/pdfs/parse', guard, async (req, res, next) => {
    try {
      const status = await pdf.enqueue({
        libraryId: text(req.body.libraryId, 'Zotero library ID', 20, { required: true }),
        attachmentKey: text(req.body.attachmentKey, 'Zotero attachment key', 64, { required: true })
      });
      res.status(202).json({ ok: true, ...status });
    } catch (error) {
      next(pdfRequestError(error));
    }
  });

  router.get('/library/pdfs/search', async (req, res, next) => {
    try {
      await pdf.ready?.();
      const pdfQuery = text(req.query.q, '搜索词', 500);
      const result = pdfLookup.search(pdfQuery);
      res.render('pdf-search', {
        title: 'PDF 全文搜索',
        pdfQuery: result.query,
        results: result.results,
        usedFallback: result.usedFallback
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/library/pdfs/:documentId/status', async (req, res, next) => {
    try {
      await pdf.ready?.();
      const id = pdfDocumentId(req.params.documentId);
      const status = pdf.status(id);
      if (!status) throw httpError(404, '找不到这个 PDF 解析任务。');
      res.json({ ok: true, ...status });
    } catch (error) {
      next(error);
    }
  });

  router.get('/library/pdfs/:documentId', async (req, res, next) => {
    try {
      await pdf.ready?.();
      const id = pdfDocumentId(req.params.documentId);
      const preview = pdf.preview(id, { chunkIndex: pdfChunkIndex(req.query.chunk) });
      if (!preview) throw httpError(404, '找不到这个 PDF 的解析正文。');
      res.render('pdf-preview', {
        title: preview.document.title || preview.document.fileName,
        preview: {
          ...preview,
          chunks: preview.chunks.map(chunk => ({
            ...chunk,
            html: renderMarkdown(chunk.markdown, () => '', { anchors: false, images: false })
          }))
        }
      });
    } catch (error) {
      next(error);
    }
  });

  /** 从 Zotero 条目生成文献笔记（题录 + 标注）。 */
  router.post('/library/lit', guard, async (req, res, next) => {
    try {
      const key = zoteroKey(req.body.key);
      const existing = db.raw.prepare(`
        SELECT path FROM notes WHERE section = 'lit' AND json_extract(data_json, '$.zotero') = ?
      `).get(key);
      if (existing) throw httpError(409, '这篇文献笔记已经存在。');

      const [items, annotations] = await Promise.all([
        zotero.fetchItems({ base: config.zoteroApi }),
        zotero.readAnnotations(config.zoteroDataDir)
      ]);
      if (!items.available) throw httpError(400, items.reason);

      const item = (items.items || []).find(entry => entry.key === key);
      if (!item) throw httpError(404, '在 Zotero 里找不到这个条目。');

      const notePath = zotero.litPath(key);
      const matched = (annotations.items || []).find(entry => entry.key === key);
      await enqueueNote(config.notesDir, notePath, async () => {
        try {
          await writeNote(config.notesDir, notePath, {
            raw: renderLiteratureNote({ item, annotations: matched?.annotations || [] })
          }, { exclusive: true });
        } catch (error) {
          if (error.code === 'EEXIST') {
            throw httpError(409, '文献笔记路径已被其它内容占用。');
          }
          throw error;
        }
      });
      await indexer.scan({ paths: [notePath] });

      res.json({ ok: true, path: notePath, annotations: matched?.annotations.length || 0 });
    } catch (error) {
      next(error);
    }
  });

  router.post('/library/lit/sync', guard, async (req, res, next) => {
    try {
      const key = zoteroKey(req.body.key);
      const row = db.raw.prepare(`
        SELECT path FROM notes WHERE section = 'lit' AND json_extract(data_json, '$.zotero') = ?
      `).get(key);
      if (!row) throw httpError(404, '这篇文献笔记还不存在。');
      const notePath = row.path;
      const annotations = await zotero.readAnnotations(config.zoteroDataDir);
      if (!annotations.available) throw httpError(400, annotations.reason);
      const matched = (annotations.items || []).find(entry => entry.key === key);
      const result = await syncLiteratureNote({
        notesDir: config.notesDir,
        notePath,
        itemKey: key,
        annotations: matched?.annotations || [],
        expectedHash: text(req.body.expectedHash, '笔记版本', 128)
      });
      await indexer.scan({ paths: [notePath] });
      const written = await readNote(config.notesDir, notePath);
      res.json({
        ok: true,
        path: notePath,
        ...result,
        hash: written.hash,
        pendingAnnotations: parseManagedAnnotations(written.body).filter(entry => entry.status === 'pending')
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/library/annotations/process', guard, async (req, res, next) => {
    try {
      const payload = processingPayload(req.body);
      const normalizedPath = toPosix(payload.notePath);
      if (!isSafeRelativePath(normalizedPath) || !normalizedPath.startsWith('lit/') || !normalizedPath.endsWith('.md')) {
        throw httpError(400, '文献笔记路径无效。');
      }
      payload.notePath = normalizedPath;
      let result;
      try {
        result = await processAnnotation({
          vaultDir: config.vaultDir,
          notesDir: config.notesDir,
          ...payload
        });
      } catch (error) {
        if (error.writes?.notes?.length) await indexer.scan({ paths: error.writes.notes });
        throw error;
      }
      if (result.writes.notes.length) await indexer.scan({ paths: result.writes.notes });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createIntegrationRoutes };
