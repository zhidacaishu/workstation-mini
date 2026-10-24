const { tokenizeToText } = require('../segment');

const MAX_CHUNK_LENGTH = 2_000;
const IGNORED_TYPES = new Set([
  'header', 'footer', 'page_header', 'page_footer', 'page_number',
  'discarded', 'ignore', 'interline_equation'
]);

function textValue(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join('\n');
  return '';
}

// MinerU 的 table_body 给的是 HTML。渲染器是 html:false（正文来路不明，不能开），
// 直接塞进 markdown 的话表格会变成一行转义后的标签源码。把它翻成 GFM 管道表，
// markdown-it 原生就能渲染成真正的 <table>，既可读又不用放开 HTML。
function decodeEntities(value) {
  return String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

function tableCellText(value) {
  return decodeEntities(
    String(value).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim()
    .replaceAll('|', '\\|');
}

const MAX_TABLE_COLUMNS = 64;
// 超过这个体量就别翻了：一是渲染出来也读不了，二是标签不闭合的超长串会让
// 逐行匹配退化成平方复杂度。翻不动时保留原文，stripMarkup 仍能取出可索引文本。
const MAX_TABLE_HTML_LENGTH = 256_000;

/**
 * 按开标签切段，而不是用 `<tag>(.*?)</tag>` 去配对。
 *
 * 配对写法在标签不闭合时会退化成平方复杂度：每个开标签都要把懒惰匹配一路
 * 扫到文末才放弃。MinerU 的表格恰恰经常缺闭合标签，几万个未闭合的 <td> 就能
 * 让这一个函数同步阻塞事件循环好几秒 —— 而 initialize() 会对每篇 ready 的
 * 文献都跑一遍。按开标签定位再裁掉尾部闭合标签是线性的，结果也一样。
 */
function splitByOpenTag(source, pattern, closing) {
  const starts = [...source.matchAll(pattern)].map(match => ({
    index: match.index,
    end: match.index + match[0].length,
    attributes: match[2] || ''
  }));
  return starts.map((start, position) => ({
    attributes: start.attributes,
    content: source
      .slice(start.end, position + 1 < starts.length ? starts[position + 1].index : source.length)
      .replace(closing, '')
  }));
}

function htmlTableToMarkdown(value) {
  const source = String(value || '');
  if (source.length > MAX_TABLE_HTML_LENGTH) return '';
  if (!/<t[rdh][\s>]/i.test(source)) return '';

  const rows = [];
  for (const row of splitByOpenTag(source, /<(tr)()[^>]*>/gi, /<\/tr\s*>[\s\S]*$/i)) {
    const cells = [];
    for (const cell of splitByOpenTag(row.content, /<(t[hd])([^>]*)>/gi, /<\/t[hd]\s*>[\s\S]*$/i)) {
      const span = Number(/colspan\s*=\s*["']?(\d+)/i.exec(cell.attributes)?.[1]) || 1;
      cells.push(tableCellText(cell.content));
      for (let extra = 1; extra < Math.min(span, MAX_TABLE_COLUMNS); extra += 1) cells.push('');
    }
    if (cells.some(Boolean)) rows.push(cells.slice(0, MAX_TABLE_COLUMNS));
  }
  if (!rows.length) return '';

  const width = Math.max(...rows.map(row => row.length));
  const padded = rows.map(row => [...row, ...Array(width - row.length).fill('')]);
  return [
    `| ${padded[0].join(' | ')} |`,
    `| ${Array(width).fill('---').join(' | ')} |`,
    ...padded.slice(1).map(row => `| ${row.join(' | ')} |`)
  ].join('\n');
}

function stripMarkup(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>|~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function blockContent(block) {
  const type = String(block?.type || '').toLowerCase();
  if (IGNORED_TYPES.has(type)) return null;

  if (type === 'title' || type === 'heading') {
    const text = textValue(block.text || block.content);
    return text ? { kind: 'heading', body: text, markdown: `### ${text}` } : null;
  }

  if (type === 'text') {
    const text = textValue(block.text || block.content);
    if (!text) return null;
    const level = Number(block.text_level ?? block.level);
    if (Number.isInteger(level) && level >= 0) {
      return { kind: 'heading', body: text, markdown: `${'#'.repeat(Math.min(level + 2, 6))} ${text}` };
    }
    return { kind: 'body', body: text, markdown: text };
  }

  if (type === 'list') {
    const values = Array.isArray(block.list_items)
      ? block.list_items.map(textValue).filter(Boolean)
      : [textValue(block.text || block.content)].filter(Boolean);
    if (!values.length) return null;
    return {
      kind: 'body',
      body: values.join('\n'),
      markdown: values.map(value => `- ${value}`).join('\n')
    };
  }

  if (type === 'equation' || type === 'formula') {
    const text = textValue(block.text || block.latex || block.content);
    return text ? { kind: 'body', body: text, markdown: `$$\n${text}\n$$` } : null;
  }

  if (type === 'table') {
    const caption = textValue(block.table_caption || block.caption);
    const raw = textValue(block.table_body || block.text || block.content);
    // 翻不动就原样保留：有些 MinerU 版本直接给管道表，不该被当成 HTML 处理。
    const table = htmlTableToMarkdown(raw) || raw;
    const body = [caption, stripMarkup(raw)].filter(Boolean).join('\n');
    const markdown = [caption ? `**${caption}**` : '', table].filter(Boolean).join('\n\n');
    return body ? { kind: 'body', body, markdown } : null;
  }

  if (type === 'image' || type === 'figure') {
    const caption = textValue(block.image_caption || block.figure_caption || block.caption);
    const footnote = textValue(block.image_footnote || block.footnote);
    const body = [caption, footnote].filter(Boolean).join('\n');
    return body ? { kind: 'body', body, markdown: body } : null;
  }

  const fallback = textValue(block?.text || block?.content);
  return fallback ? { kind: 'body', body: fallback, markdown: fallback } : null;
}

// MinerU 经常把一整页正文吐成一个 text 块。原来只在「往已有块里追加」时判长度，
// 块本身超限就整块进 chunk，于是 chunk 长度实际没有上限：BM25 的长度归一化失真，
// 而 answerFromPassages 只截前 1200 字，超出的部分会被无声丢掉，引用编号却照给。
// 只切纯文本块（markdown 和 body 一致的那些）；表格、公式、列表是结构化的，
// 从中间切断只会毁掉排版。
const SENTENCE_END = /[。！？；.!?;\n]/;

function splitLongText(value, maxLength) {
  // 切点至少要往前走一个字符，否则 maxLength 传成 0 或负数时这里会空转。
  const limit = Math.max(1, Math.trunc(Number(maxLength) || 0));
  const parts = [];
  let rest = String(value);
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const floor = Math.floor(limit * 0.4);
    let cut = -1;
    for (let index = window.length - 1; index > floor; index -= 1) {
      if (SENTENCE_END.test(window[index])) {
        cut = index + 1;
        break;
      }
    }
    if (cut < 0) {
      const space = window.lastIndexOf(' ');
      cut = space > floor ? space + 1 : limit;
    }
    // 别在代理对中间下刀：切出来的两半各自都不是合法 UTF-16（emoji、部分
    // 生僻汉字都是两个 code unit）。
    const before = rest.charCodeAt(cut - 1);
    const after = rest.charCodeAt(cut);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) cut -= 1;
    if (cut < 1) cut = Math.min(2, rest.length);
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  const tail = rest.trim();
  if (tail) parts.push(tail);
  return parts.filter(Boolean);
}

function contentSegments(content, maxChunkLength) {
  if (content.markdown !== content.body || content.body.length <= maxChunkLength) {
    return [{ body: content.body, markdown: content.markdown }];
  }
  return splitLongText(content.body, maxChunkLength).map(part => ({ body: part, markdown: part }));
}

function contentEntries(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.content_list)) return value.content_list;
  if (value && Array.isArray(value.data)) return value.data;
  throw new Error('MinerU content_list.json 结构无法识别。');
}

function parseContentList(value, { maxChunkLength = MAX_CHUNK_LENGTH } = {}) {
  const entries = contentEntries(value);
  const chunks = [];
  let heading = '';
  let current = null;
  let maxPage = -1;

  function flush() {
    if (!current?.bodyParts.length) {
      current = null;
      return;
    }
    const body = current.bodyParts.join('\n\n').trim();
    const markdown = current.markdownParts.join('\n\n').trim();
    chunks.push({
      chunkIndex: chunks.length,
      pageIndex: current.pageIndex,
      heading: current.heading,
      body,
      markdown,
      headingTokens: tokenizeToText(current.heading),
      bodyTokens: tokenizeToText(body)
    });
    current = null;
  }

  let accepted = 0;
  let skipped = 0;

  for (const block of entries) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const content = blockContent(block);
    if (!content) continue;
    const pageIndex = Number(block.page_idx ?? block.pageIndex);
    if (!Number.isInteger(pageIndex) || pageIndex < 0) {
      // 页码不可靠的块单独跳过，而不是让整篇解析失败：一个坏块废掉一篇已经
      // 付费解析完的论文太贵了。但如果过半的块都这样，说明 MinerU 换了格式，
      // 那就该硬失败，而不是把一份残缺的索引悄悄建起来。
      skipped += 1;
      continue;
    }
    accepted += 1;
    maxPage = Math.max(maxPage, pageIndex);

    if (content.kind === 'heading') {
      flush();
      heading = content.body;
      continue;
    }

    for (const segment of contentSegments(content, maxChunkLength)) {
      // 算上 join 用的空行，否则拼出来的 body 会比上限多两个字符。
      const projected = current
        ? current.bodyParts.join('\n\n').length + 2 + segment.body.length
        : segment.body.length;
      if (!current || current.pageIndex !== pageIndex || projected > maxChunkLength) {
        flush();
        current = { pageIndex, heading, bodyParts: [], markdownParts: [] };
      }
      current.bodyParts.push(segment.body);
      current.markdownParts.push(segment.markdown);
    }
  }
  flush();

  // 用 >=：坏块和好块一样多时，已经不能当成「个别块出了问题」了。
  if (skipped > 0 && skipped >= accepted) {
    throw new Error('MinerU content_list 中过半正文块缺少可靠的 page_idx。');
  }
  if (!chunks.length) throw new Error('MinerU 结果中没有可索引的 PDF 正文。');
  return { chunks, pageCount: maxPage + 1, skippedBlocks: skipped };
}

module.exports = { parseContentList, stripMarkup, htmlTableToMarkdown, splitLongText, MAX_CHUNK_LENGTH };
