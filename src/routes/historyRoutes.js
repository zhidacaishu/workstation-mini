const express = require('express');
const crypto = require('node:crypto');
const { listRecords, listDeckRecords, getRecord, saveDraft, removeDraft } = require('../vault/history');
const { readNote, parseFrontmatter, resolveTitle, hashContent } = require('../vault/note');
const { restoreDeck } = require('../cards');
const fs = require('node:fs/promises');
const { isSafeRelativePath, isNotePath, basename, ensureSafeFilePath } = require('../vault/paths');
const { compareText } = require('../lineDiff');
const { blockWhenReadOnly, httpError, writeHandler } = require('./http');

const DECK_PREFIX = 'deck:';
const HISTORY_PAGE = 100;
// 旧草稿可能有以点号开头的路径，恢复时让用户重新命名。
const needsPath = record => record.kind === 'draft' && !isNotePath(record.path);
// 超过这个大小的文件不做逐行对比，直接给全文。
const DIFF_MAX_BYTES = 2 * 1024 * 1024;

function createHistoryRoutes({ config, db }) {
  const router = express.Router();
  const guard = blockWhenReadOnly(config, '不能恢复笔记或保存草稿。');
  router.get('/api/drafts', writeHandler(async (req, res, next) => {
    try {
      // 只回答「这一篇有几份草稿」。路径为空（还没起名的新笔记）不能退化成「全部草稿」，
      // 否则别的笔记有草稿时，空白的新建页也会提示「发现 N 份未保存草稿」。
      const notePath = String(req.query.path || '');
      if (!notePath || !isNotePath(notePath)) { res.json({ count: 0 }); return; }
      const records = await listRecords(config.notesDir, notePath);
      res.json({ count: records.filter(record => record.kind === 'draft').length });
    } catch (error) { next(error); }
  }));
  // 卡组文件（cards/）不在 notes/ 里，旧版本存在资料库根目录那份本机历史里。
  // 两边的记录放在同一页：卡组记录的 id 带 deck: 前缀，恢复时直接写回卡组文件。
  async function deckRecords(deckPath = '') {
    const records = await listDeckRecords(config.vaultDir, deckPath);
    return records
      .map(record => ({ ...record, id: DECK_PREFIX + record.id, source: 'deck' }));
  }
  // 列表和预览的主文字用标题，路径退到次要位置。
  // 笔记的标题规则和别处一样（frontmatter 的 title、第一个 H1、文件名）；卡组取 frontmatter 的 deck。
  // 写坏的 frontmatter 解析不了，就退回文件名。
  function titleFromRaw(record) {
    if (needsPath(record)) return '未命名草稿';
    try {
      const parsed = parseFrontmatter(record.raw);
      return record.source === 'deck'
        ? String(parsed.data?.deck || '').trim()
        : resolveTitle(parsed.data, parsed.content, record.path);
    } catch {
      return '';
    }
  }
  // 列表里的记录不带正文。现存笔记直接用索引里的标题；索引里没有的（已删除的笔记、
  // 卡组文件）读这条路径最新的一条记录来取，同一路径只读一次，一页最多读 TITLE_READS 次。
  const TITLE_READS = 30;
  async function withTitles(records) {
    const titles = new Map();
    let reads = 0;
    for (const record of records) {
      const key = `${record.source || 'note'}:${record.path}`;
      if (needsPath(record) || titles.has(key)) continue;
      let title = record.source === 'deck' ? '' : db?.getNote?.(record.path)?.title || '';
      if (!title && reads < TITLE_READS) {
        reads += 1;
        try { title = titleFromRaw(await findRecord(record.id)); } catch {}
      }
      titles.set(key, title || basename(record.path));
    }
    return records.map(record => ({ ...record, title: needsPath(record) ? '未命名草稿' : titles.get(`${record.source || 'note'}:${record.path}`) }));
  }
  async function findRecord(id) {
    if (!id.startsWith(DECK_PREFIX)) return getRecord(config.notesDir, id);
    const record = await getRecord(config.vaultDir, id.slice(DECK_PREFIX.length));
    if (!record.path.startsWith('cards/') || !isSafeRelativePath(record.path)) throw httpError(404, '恢复记录不存在。');
    return { ...record, id, source: 'deck' };
  }

  // 这条记录对应的文件现在的内容；文件已经不在了返回 null，读不了（路径不安全、太大）返回 undefined。
  async function currentRaw(record) {
    const deck = record.source === 'deck';
    if (deck ? !record.path.startsWith('cards/') || !isSafeRelativePath(record.path) : !isNotePath(record.path)) return undefined;
    try {
      const absolute = await ensureSafeFilePath(deck ? config.vaultDir : config.notesDir, record.path);
      const stats = await fs.stat(absolute);
      if (!stats.isFile() || (!deck && stats.size > DIFF_MAX_BYTES)) return undefined;
      return await fs.readFile(absolute, 'utf8');
    } catch (error) {
      return error.code === 'ENOENT' ? null : undefined;
    }
  }
  // 逐行对比的方向跟着「时间先后」走：旧版本是「从它到现在改了什么」，
  // 没保存的草稿比文件新，是「草稿相对现在的文件改了什么」。
  function compareWithCurrent(record, current) {
    if (current === null) return { state: 'missing' };
    if (current === undefined || Buffer.byteLength(current) > DIFF_MAX_BYTES || Buffer.byteLength(record.raw) > DIFF_MAX_BYTES) return { state: 'unavailable' };
    const draft = record.kind === 'draft';
    const result = draft ? compareText(current, record.raw) : compareText(record.raw, current);
    if (result.tooLarge) return { state: 'unavailable' };
    if (!result.changed) return { state: 'same' };
    return { state: 'diff', draft, ...result };
  }

  function deckVersion(raw) {
    if (raw === undefined) return '';
    return raw === null ? 'missing' : hashContent(raw);
  }

  router.get('/history', writeHandler(async (req, res, next) => {
    try {
      const notePath = String(req.query.path || '');
      const deckPath = String(req.query.deck || '');
      if (notePath && !isNotePath(notePath)) throw httpError(400, '路径不合法。');
      if (deckPath && (!deckPath.startsWith('cards/') || !isSafeRelativePath(deckPath))) throw httpError(400, '路径不合法。');
      const all = deckPath
        ? await deckRecords(deckPath)
        : [...await listRecords(config.notesDir, notePath), ...(notePath ? [] : await deckRecords())]
          .sort((left, right) => String(right.at).localeCompare(String(left.at)));
      // 一页最多列 HISTORY_PAGE 条：记录多了以后整页几 MB，打开都慢。
      const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
      const records = await withTitles(all.slice((page - 1) * HISTORY_PAGE, page * HISTORY_PAGE));
      const found = req.query.id ? await findRecord(String(req.query.id)) : null;
      // 预览的是这一条记录本身，标题也取它自己的内容：旧版本可能还是改名前的标题。
      const selected = found ? { ...found, title: titleFromRaw(found) || basename(found.path) } : null;
      const current = selected ? await currentRaw(found) : undefined;
      const expectedHash = selected?.source === 'deck' ? deckVersion(current) : '';
      const comparison = selected ? compareWithCurrent(found, current) : null;
      const showFull = req.query.view === 'full' || !comparison || comparison.state !== 'diff';
      res.render('history', {
        title: '版本历史与草稿', records, selected, notePath, deckPath, comparison, showFull, expectedHash,
        page, hasMore: all.length > page * HISTORY_PAGE, total: all.length
      });
    } catch (error) { next(error.code === 'ENOENT' ? httpError(404, '恢复记录不存在。') : error); }
  }));
  router.post('/history/restore-deck', guard, writeHandler(async (req, res, next) => {
    try {
      const record = await findRecord(String(req.body?.id || ''));
      if (record.source !== 'deck') throw httpError(400, '这条记录不是卡组版本。');
      await restoreDeck(config.vaultDir, record.path, record.raw, req.body.expectedHash);
      res.redirect('/cards');
    } catch (error) { next(error.code === 'ENOENT' ? httpError(404, '恢复记录不存在。') : error); }
  }));
  router.get('/recover/:id', guard, writeHandler(async (req, res, next) => {
    try {
      const record = await getRecord(config.notesDir, req.params.id);
      const unnamed = needsPath(record);
      let current;
      if (!unnamed) {
        if (!isNotePath(record.path)) throw httpError(404, '恢复记录不存在。');
        try { current = await readNote(config.notesDir, record.path, { tolerateInvalid: true }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      res.render('edit', {
        title: '恢复笔记', notePath: unnamed ? '' : record.path, body: record.raw,
        expectedHash: current?.hash || '', isNew: !current,
        draftId: crypto.randomUUID(), recovered: true, autoPath: unnamed,
        folder: unnamed && record.folder && isNotePath(record.folder + '/x.md') ? record.folder : 'inbox',
        recoveredSequence: record.sequence,
        recoveredFrom: record.kind === 'draft' ? record.id : '',
        editorWarning: current
          ? '已载入恢复内容，尚未覆盖当前文件。请核对后保存；当前版本会保留在历史中。'
          : unnamed ? '已载入未命名草稿。填写标题或保存路径后即可保存。'
            : '已载入恢复内容，尚未写入笔记。保存后将重新创建文件。'
      });
    } catch (error) { next(error.code === 'ENOENT' ? httpError(404, '恢复记录不存在。') : error); }
  }));
  router.post('/api/drafts/:id', guard, writeHandler(async (req, res, next) => {
    try { res.json({ ok: true, ...await saveDraft(config.notesDir, req.params.id, req.body) }); }
    catch (error) { next(error); }
  }));
  router.delete('/api/drafts/:id', guard, writeHandler(async (req, res, next) => {
    try {
      await removeDraft(config.notesDir, req.params.id, Number(req.body.sequence));
      res.json({ ok: true });
    } catch (error) { next(error); }
  }));
  return router;
}
module.exports = { createHistoryRoutes };
