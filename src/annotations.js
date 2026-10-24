const { appendCard } = require('./cards');
const { hashContent, readNote, writeNote, stringifyFrontmatter } = require('./vault/note');
const { enqueueNote } = require('./vault/note-queue');

const REGION_BEGIN = '<!-- workstation:annotations:v1 begin -->';
const REGION_END = '<!-- workstation:annotations:v1 end -->';
const TASKS_BEGIN = '<!-- workstation:annotation-tasks:v1 begin -->';
const TASKS_END = '<!-- workstation:annotation-tasks:v1 end -->';
const ANNOTATION_PREFIX = '<!-- workstation:annotation:v1 ';
const TASK_PREFIX = '<!-- workstation:annotation-task:v1 ';
const DIRECTIVE_LINE = /^\s*<!--\s*workstation:[\w-]+:v\d+(?:\s+.*)?-->\s*$/gm;

function stableId(itemKey, itemId) {
  return `${String(itemKey).trim()}:${Number(itemId)}`;
}

function normalizeAnnotation(annotation, itemKey) {
  const itemId = Number(annotation.itemID ?? annotation.itemId);
  if (!Number.isSafeInteger(itemId) || itemId < 1) throw new Error('Zotero 标注缺少稳定 itemID。');
  return {
    id: stableId(itemKey, itemId),
    itemKey: String(itemKey),
    itemId,
    text: String(annotation.text || '').trim(),
    comment: String(annotation.comment || '').trim(),
    page: String(annotation.page || '').trim(),
    color: String(annotation.color || ''),
    sortIndex: String(annotation.sortIndex || ''),
    status: 'pending',
    processedAt: '',
    outputs: []
  };
}

function marker(prefix, data) {
  return `${prefix}${JSON.stringify(data)} -->`;
}

function quoteLines(text) {
  return String(text).split('\n').map(line => `> ${line}`).join('\n');
}

function renderAnnotation(annotation) {
  const metadata = {
    id: annotation.id,
    itemKey: annotation.itemKey,
    itemId: annotation.itemId,
    text: annotation.text,
    comment: annotation.comment,
    page: annotation.page,
    color: annotation.color,
    sortIndex: annotation.sortIndex,
    status: annotation.status,
    processedAt: annotation.processedAt || '',
    outputs: [...new Set(annotation.outputs || [])].sort()
  };
  const page = annotation.page ? `  （p.${annotation.page}）` : '';
  return [
    marker(ANNOTATION_PREFIX, metadata),
    `${quoteLines(annotation.text)}${page}`,
    ...(annotation.comment ? ['', annotation.comment] : []),
    ''
  ].join('\n');
}

function renderRegion(annotations, unmatchedLegacy = '') {
  const lines = [
    `## 标注（${annotations.length} 条）`,
    '',
    REGION_BEGIN,
    ...annotations.map(renderAnnotation),
    REGION_END
  ];
  if (unmatchedLegacy.trim()) {
    lines.push('', '### 迁移时未匹配的旧标注内容', '', unmatchedLegacy.trim());
  }
  return `${lines.join('\n')}\n`;
}

function parseMarker(line, prefix) {
  const trimmed = line.trim();
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith('-->')) return null;
  try {
    return JSON.parse(trimmed.slice(prefix.length, -3).trim());
  } catch {
    return null;
  }
}

function parseManagedAnnotations(body) {
  const source = String(body || '');
  const begin = source.indexOf(REGION_BEGIN);
  const end = source.indexOf(REGION_END, begin + REGION_BEGIN.length);
  if (begin < 0 || end < 0) return [];
  return source.slice(begin + REGION_BEGIN.length, end).split('\n')
    .map(line => parseMarker(line, ANNOTATION_PREFIX))
    .filter(value => value?.id && value?.itemKey && Number.isSafeInteger(value.itemId))
    .map(value => ({
      ...value,
      text: String(value.text || ''),
      comment: String(value.comment || ''),
      page: String(value.page || ''),
      color: String(value.color || ''),
      sortIndex: String(value.sortIndex || ''),
      status: value.status === 'processed' ? 'processed' : 'pending',
      processedAt: String(value.processedAt || ''),
      outputs: Array.isArray(value.outputs) ? value.outputs.map(String) : []
    }));
}

function stripMachineDirectives(markdown) {
  return String(markdown || '').replace(DIRECTIVE_LINE, '').replace(/\n{3,}/g, '\n\n');
}

function h2Sections(body) {
  const lines = String(body || '').split('\n');
  const sections = [];
  let fence = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = '';
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) sections.push({ title: heading[1], startLine: index });
  }
  return sections.map((section, index) => ({
    ...section,
    endLine: sections[index + 1]?.startLine ?? lines.length,
    lines
  }));
}

function findAnnotationSection(body) {
  return h2Sections(body).find(section => /^标注(?:（\d+\s*条）)?$/.test(section.title));
}

function parseLegacyBlocks(section) {
  if (!section) return [];
  const content = section.lines.slice(section.startLine + 1, section.endLine);
  if (content.join('\n').includes('还没有标注')) return [];
  const blocks = [];
  let index = 0;
  while (index < content.length) {
    if (!/^>\s?/.test(content[index])) {
      index += 1;
      continue;
    }
    const quote = [];
    while (index < content.length && /^>\s?/.test(content[index])) {
      quote.push(content[index].replace(/^>\s?/, ''));
      index += 1;
    }
    const comment = [];
    while (index < content.length && !/^>\s?/.test(content[index])) {
      comment.push(content[index]);
      index += 1;
    }
    const joined = quote.join('\n').trim();
    const pageMatch = joined.match(/\s{2}（p\.([^）]+)）$/);
    blocks.push({
      text: (pageMatch ? joined.slice(0, pageMatch.index) : joined).trim(),
      page: pageMatch?.[1]?.trim() || '',
      comment: comment.join('\n').trim(),
      raw: [...quote.map(line => `> ${line}`), ...comment].join('\n').trim()
    });
  }
  return blocks;
}

function normalized(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function matchLegacy(legacy, current, used) {
  const candidates = current.filter(annotation => !used.has(annotation.id) && normalized(annotation.text) === normalized(legacy.text));
  const exact = candidates.filter(annotation => normalized(annotation.comment) === normalized(legacy.comment) && normalized(annotation.page) === normalized(legacy.page));
  if (exact.length === 1) return exact[0];
  const page = candidates.filter(annotation => normalized(annotation.page) === normalized(legacy.page));
  if (legacy.page && page.length === 1) return page[0];
  const comment = candidates.filter(annotation => normalized(annotation.comment) === normalized(legacy.comment));
  if (legacy.comment && comment.length === 1) return comment[0];
  return candidates.length === 1 ? candidates[0] : null;
}

function managedConflict() {
  const error = new Error('受管理标注区包含手写或无法识别的内容，未执行覆盖。请将手写内容移到标记之外后重试。');
  error.status = 409;
  return error;
}

function replaceManagedRegion(body, annotations) {
  const source = String(body || '');
  const section = findAnnotationSection(source);
  if (!section) throw managedConflict();
  const begin = source.indexOf(REGION_BEGIN);
  const end = source.indexOf(REGION_END, begin + REGION_BEGIN.length);
  if (begin < 0 || end < 0) throw managedConflict();

  const existing = parseManagedAnnotations(source);
  const actual = source.slice(begin + REGION_BEGIN.length, end).trim().replace(/\r\n/g, '\n');
  const expected = existing.map(renderAnnotation).join('\n').trim();
  if (actual !== expected) throw managedConflict();

  const managed = `${REGION_BEGIN}\n${annotations.map(renderAnnotation).join('\n')}${REGION_END}`;
  const replaced = `${source.slice(0, begin)}${managed}${source.slice(end + REGION_END.length)}`;
  const lines = replaced.split('\n');
  lines[section.startLine] = `## 标注（${annotations.length} 条）`;
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function replaceSection(body, section, replacement) {
  const lines = String(body || '').split('\n');
  lines.splice(section.startLine, section.endLine - section.startLine, ...replacement.replace(/\n$/, '').split('\n'));
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function insertBeforeThoughts(body, replacement) {
  const sections = h2Sections(body);
  const thoughts = sections.find(section => section.title === '我的想法');
  if (!thoughts) return `${String(body || '').replace(/\n+$/, '')}\n\n${replacement}\n## 我的想法\n`;
  const lines = String(body || '').split('\n');
  lines.splice(thoughts.startLine, 0, ...replacement.replace(/\n$/, '').split('\n'), '');
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function mergeAnnotations(body, itemKey, incoming) {
  const current = incoming.map(annotation => normalizeAnnotation(annotation, itemKey));
  const existing = parseManagedAnnotations(body);
  const existingById = new Map(existing.map(annotation => [annotation.id, annotation]));
  let migrated = false;
  let unmatchedLegacy = '';
  let unmatchedCount = 0;

  if (existing.length === 0) {
    const section = findAnnotationSection(body);
    if (section && !section.lines.slice(section.startLine, section.endLine).includes(REGION_BEGIN)) {
      migrated = true;
      const used = new Set();
      const unmatched = [];
      for (const legacy of parseLegacyBlocks(section)) {
        const matched = matchLegacy(legacy, current, used);
        if (matched) used.add(matched.id);
        else if (legacy.raw) unmatched.push(legacy.raw);
      }
      unmatchedLegacy = unmatched.join('\n\n');
      unmatchedCount = unmatched.length;
    }
  }

  const merged = current.map(annotation => {
    const previous = existingById.get(annotation.id);
    return previous
      ? { ...annotation, status: previous.status, processedAt: previous.processedAt, outputs: previous.outputs }
      : annotation;
  });
  const incomingIds = new Set(merged.map(annotation => annotation.id));
  for (const previous of existing) {
    if (!incomingIds.has(previous.id)) merged.push(previous);
  }
  merged.sort((a, b) => a.sortIndex.localeCompare(b.sortIndex) || a.id.localeCompare(b.id));

  const replacement = renderRegion(merged, unmatchedLegacy);
  const section = findAnnotationSection(body);
  const nextBody = existing.length
    ? replaceManagedRegion(body, merged)
    : section
      ? replaceSection(body, section, replacement)
      : insertBeforeThoughts(body, replacement);
  return {
    body: nextBody,
    annotations: merged,
    added: merged.filter(annotation => !existingById.has(annotation.id)).length,
    updated: current.filter(annotation => existingById.has(annotation.id)).length,
    pending: merged.filter(annotation => annotation.status === 'pending').length,
    migrated,
    // 报的是**没能匹配上**的块数。原来这里回的是 parseLegacyBlocks(section).length，
    // 也就是旧标注块的总数 —— 字段名和值对不上，界面上会把迁移损失说得比实际严重。
    unmatchedLegacy: unmatchedCount
  };
}

function replaceBody(raw, oldBody, newBody) {
  return `${String(raw).slice(0, String(raw).length - String(oldBody).length)}${newBody}`;
}

async function syncLiteratureNote({ notesDir, notePath, itemKey, annotations, expectedHash = '' }) {
  return enqueueNote(notesDir, notePath, async () => {
    const note = await readNote(notesDir, notePath);
    if (expectedHash && note.hash !== expectedHash) {
      const error = new Error('文献笔记已被其它编辑修改，请刷新后重试。');
      error.status = 409;
      throw error;
    }
    const merged = mergeAnnotations(note.body, itemKey, annotations);
    const raw = replaceBody(note.raw, note.body, merged.body);
    const written = await writeNote(notesDir, notePath, { raw });
    return { ...merged, hash: written.hash };
  });
}

function renderLiteratureNote({ item, annotations = [] }) {
  const front = {
    title: item.title,
    tags: ['文献', ...(item.tags || [])],
    zotero: item.key,
    ...(item.year ? { year: item.year } : {}),
    ...(item.doi ? { doi: item.doi } : {}),
    ...(item.publication ? { publication: item.publication } : {})
  };
  const intro = [
    `# ${item.title}`,
    '',
    ...(item.creators?.length ? [`${item.creators.join('；')}${item.year ? ` · ${item.year}` : ''}`, ''] : []),
    ...(item.publication ? [`*${item.publication}*`, ''] : [])
  ].join('\n');
  const managed = annotations.map(annotation => normalizeAnnotation(annotation, item.key));
  return stringifyFrontmatter(`${intro}${renderRegion(managed)}\n## 我的想法\n`, front);
}

function renderTaskRegion(body, annotationId, title, sourcePath) {
  const source = String(body || '');
  const markerLine = marker(TASK_PREFIX, { id: annotationId });
  if (source.includes(markerLine)) return source;
  const task = `${markerLine}\n- [ ] ${String(title).trim()} [[${sourcePath.replace(/\.md$/i, '')}]]`;
  const begin = source.indexOf(TASKS_BEGIN);
  const end = source.indexOf(TASKS_END, begin + TASKS_BEGIN.length);
  if (begin >= 0 && end >= 0) {
    return `${source.slice(0, end).replace(/\n*$/, '\n')}${task}\n${source.slice(end)}`;
  }
  return `${source.replace(/\n+$/, '')}\n\n## 标注行动\n\n${TASKS_BEGIN}\n${task}\n${TASKS_END}\n`;
}

async function ensurePermanentNote(notesDir, annotation, sourcePath, options) {
  const relative = `research/zotero-${annotation.itemKey}-${annotation.itemId}.md`;
  const title = String(options.title || annotation.comment || annotation.text).trim();
  const data = { title, tags: ['文献笔记'], workstation_annotation: annotation.id };
  const body = `# ${title}\n\n${String(options.body || annotation.comment || annotation.text).trim()}\n\n来源：[[${sourcePath.replace(/\.md$/i, '')}]]\n`;
  return enqueueNote(notesDir, relative, async () => {
    try {
      await writeNote(notesDir, relative, { data, body }, { exclusive: true });
      return { path: relative, changed: true };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readNote(notesDir, relative);
      if (String(existing.data.workstation_annotation) !== annotation.id) {
        const conflict = new Error('永久笔记路径已被其它内容占用。');
        conflict.status = 409;
        throw conflict;
      }
      return { path: relative, changed: false };
    }
  });
}

async function processAnnotation({ vaultDir, notesDir, notePath, annotationId, expectedHash, outputs = {}, now = () => new Date().toISOString() }) {
  return enqueueNote(notesDir, notePath, async () => {
    let note = await readNote(notesDir, notePath);
    if (expectedHash && note.hash !== expectedHash) {
      const error = new Error('文献笔记已被其它编辑修改，请刷新后重试。');
      error.status = 409;
      throw error;
    }
    const sourceHash = note.hash;
    const annotation = parseManagedAnnotations(note.body).find(entry => entry.id === annotationId);
    if (!annotation) {
      const error = new Error('找不到这条标注。');
      error.status = 404;
      throw error;
    }

    const completed = [];
    const writes = { notes: [], vault: [] };
    try {
      if (outputs.note) {
        const permanent = await ensurePermanentNote(notesDir, annotation, notePath, outputs.note);
        if (permanent.changed) writes.notes.push(permanent.path);
        completed.push('note');
      }
      if (outputs.card) {
        const card = await appendCard(vaultDir, {
          deckFile: outputs.card.deckFile || 'inbox',
          front: outputs.card.front || annotation.text,
          back: outputs.card.back || annotation.comment || annotation.text,
          source: notePath,
          managedId: annotation.id
        });
        if (card.changed) writes.vault.push(card.path);
        completed.push('card');
      }

      note = await readNote(notesDir, notePath);
      if (note.hash !== sourceHash) {
        const error = new Error('文献笔记在生成输出期间被修改，请刷新后重试。');
        error.status = 409;
        throw error;
      }
      let body = note.body;
      if (outputs.task) {
        body = renderTaskRegion(body, annotation.id, outputs.task.title || annotation.comment || annotation.text, notePath);
      }
      const allOutputs = outputs.task ? [...completed, 'task'] : completed;
      const records = parseManagedAnnotations(body).map(entry => {
        if (entry.id !== annotation.id) return entry;
        const nextOutputs = [...new Set([...(entry.outputs || []), ...allOutputs])].sort();
        return {
          ...entry,
          status: 'processed',
          processedAt: entry.status === 'processed' && entry.processedAt ? entry.processedAt : now(),
          outputs: nextOutputs
        };
      });
      body = replaceManagedRegion(body, records);
      const raw = replaceBody(note.raw, note.body, body);
      let hash = note.hash;
      if (raw !== note.raw) {
        const written = await writeNote(notesDir, notePath, { raw });
        hash = written.hash;
        writes.notes.push(notePath);
      }
      return {
        ok: true,
        annotationId,
        outputs: allOutputs,
        hash,
        writes: {
          notes: [...new Set(writes.notes)],
          vault: [...new Set(writes.vault)]
        }
      };
    } catch (error) {
      error.completedOutputs = [...completed];
      error.writes = {
        notes: [...new Set(writes.notes)],
        vault: [...new Set(writes.vault)]
      };
      throw error;
    }
  });
}

module.exports = {
  REGION_BEGIN,
  REGION_END,
  TASKS_BEGIN,
  TASKS_END,
  stableId,
  normalizeAnnotation,
  renderRegion,
  renderLiteratureNote,
  parseManagedAnnotations,
  stripMachineDirectives,
  mergeAnnotations,
  syncLiteratureNote,
  processAnnotation,
  renderTaskRegion
};
