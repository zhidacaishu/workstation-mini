const path = require('node:path');
const { maskCode } = require('./vault/wikilink');
const { maskMath } = require('./mathSyntax');

const { toPosix, stripExtension, wikilinkTarget, isSafeRelativePath, ensureSafeFilePath } = require('./vault/paths');
const { listNotes, parseFrontmatter, stringifyFrontmatter, readNote, writeNote } = require('./vault/note');
const { enqueueFile, enqueueFiles, queueKey } = require('./vault/note-queue');
const fsp = require('node:fs/promises');

const CARDS_DIR = 'cards';

// 卡片类型。英语生词、学术表达、教材知识点、公式、挖空 —— 数据结构完全一样，
// 差别只在渲染和筛选，所以共用一套调度器。
const CARD_TYPES = ['en-word', 'en-phrase', 'concept', 'formula', 'cloze'];
const DEFAULT_TYPE = 'concept';

const CLOZE_PATTERN = /\{\{([^{}]+)\}\}/g;

/**
 * 卡片文件的格式就是普通 Markdown：
 *
 *   ---
 *   deck: 英语生词
 *   type: en-word
 *   ---
 *
 *   ## heterogeneity
 *   异质性；个体差异。来自 [[reading/econ/ch03]]
 *
 * `##` 标题是正面，到下一个 `##` 之前的正文是背面。
 * 这样卡片文件本身就是一篇能读的笔记，不是一堆只有程序看得懂的记录。
 *
 * 标题下面可以有一行卡片元数据（在应用里编辑或暂停卡片时才会写）：
 *
 *   ## heterogeneity
 *   <!-- workstation:card:v1 {"id":"english/heterogeneity","suspended":true} -->
 *
 * id 把卡片身份固定下来：改了正面、挪到别的卡组，复习记录仍然接得上；
 * suspended 表示暂停复习。这一行在阅读和复习时都不显示。
 */
const CARD_META_LINE = /^[ \t]*<!--[ \t]*workstation:card:v1[ \t]+(\{.*\})[ \t]*-->[ \t]*$/;
const DIRECTIVE_LINE = /^[ \t]*<!--[ \t]*workstation:[\w-]+:v\d+(?:[ \t]+.*)?-->[ \t]*$/;

function parseCardMeta(json) {
  try {
    const value = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const meta = {};
    if (typeof value.id === 'string' && value.id.trim()) meta.id = value.id.trim();
    if (typeof value.legacy === 'string' && value.legacy.trim()) meta.legacy = value.legacy.trim();
    if (value.suspended === true) meta.suspended = true;
    return meta;
  } catch {
    return {};
  }
}

// Windows 上 Git 默认把换行转成 CRLF。按 \n 切出来的每行末尾会多一个 \r，
// 标题正则里的 `.` 匹配不了它，于是一整份卡组一张卡都认不出来。匹配时先去掉，
// 写回时再按文件原来的换行风格补上。
function stripCR(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** 背面只去掉开头的空行和结尾的空白：首行的缩进（缩进代码块）要留着。 */
function trimBack(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();
}

function splitCards(body) {
  const lines = String(body ?? '').split('\n');
  const cards = [];
  let current = null;
  let fence = '';

  lines.forEach((rawLine, index) => {
    const line = stripCR(rawLine);
    // 代码块里的 ## 是注释或标题语法，不是卡片分隔符。
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = '';
    }

    // CommonMark 里结尾的 `#` 只有前面有空白时才算收尾标记，所以 `## C#` 的
    // 标题是「C#」而不是「C」。
    const heading = fence ? null : line.match(/^##[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/);
    if (heading) {
      if (current) {
        current.end = index;
        cards.push(current);
      }
      current = {
        front: heading[1].trim(),
        // 旧版本把 `## C#` 读成了「C」，并用它算出卡片 ID 写进了复习日志。
        // ID 必须沿用旧算法，否则这些卡的复习历史会在升级后全部断掉。
        idFront: line.match(/^##[ \t]+(.+?)[ \t]*#*[ \t]*$/)[1].trim(),
        backLines: [],
        meta: {},
        metaLine: -1,
        start: index
      };
      return;
    }
    // 机器指令行（卡片元数据、旧版文献标注留下的标记）不属于背面。
    if (!fence && DIRECTIVE_LINE.test(line)) {
      const meta = line.match(CARD_META_LINE);
      if (meta && current && current.metaLine < 0) {
        current.meta = parseCardMeta(meta[1]);
        current.metaLine = index;
      }
      return;
    }
    if (current) current.backLines.push(line);
  });
  if (current) {
    current.end = lines.length;
    cards.push(current);
  }

  return cards.map(card => ({
    front: card.front,
    idFront: card.idFront,
    back: trimBack(card.backLines.join('\n')),
    meta: card.meta,
    metaLine: card.metaLine,
    start: card.start,
    end: card.end
  }));
}

const CLOZE_OPEN = '\uE000';
const CLOZE_CLOSE = '\uE001';

/** 把渲染好的 HTML 里的挖空标记换成高亮标签，复习时答案在原位亮出来。 */
function markClozeAnswers(html) {
  return String(html).replaceAll(CLOZE_OPEN, '<mark class="cloze-answer">').replaceAll(CLOZE_CLOSE, '</mark>');
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

// 标记能不能安全地换成 <mark>：成对出现、不落在标签的属性里、夹着的那段 HTML 自己是配平的
// （答案跨了段落或列表项时，<mark> 会横跨块级边界，得到的是坏掉的 HTML）。
function clozeMarksAreInline(html) {
  let open = false;
  let depth = 0;
  const pattern = /<[^>]*>|[\uE000\uE001]/g;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    const token = match[0];
    if (token === CLOZE_OPEN) {
      if (open) return false;
      open = true; depth = 0;
    } else if (token === CLOZE_CLOSE) {
      if (!open || depth !== 0) return false;
      open = false;
    } else {
      if (token.includes(CLOZE_OPEN) || token.includes(CLOZE_CLOSE)) return false;
      if (!open) continue;
      const tag = /^<(\/?)([a-zA-Z][\w:-]*)/.exec(token);
      if (!tag || token.endsWith('/>') || VOID_TAGS.has(tag[2].toLowerCase())) continue;
      depth += tag[1] ? -1 : 1;
      if (depth < 0) return false;
    }
  }
  return !open;
}

/**
 * 挖空卡翻面后的 HTML：整句填好，答案高亮。render 是把 Markdown 变成 HTML 的函数。
 * 标记字符夹在答案两侧，偶尔会改变排版（答案是独占一行的公式、列表、代码块）；
 * 那种情况不高亮，原样给出填好的内容——宁可少一点提示，不能把公式显示成源码。
 */
function renderClozeAnswer(text, render) {
  const cloze = parseCloze(text);
  const plain = render(cloze.filled);
  if (!cloze.hasCloze) return plain;
  const marked = render(cloze.marked);
  if (marked.replaceAll(CLOZE_OPEN, '').replaceAll(CLOZE_CLOSE, '') !== plain) return plain;
  return clozeMarksAreInline(marked) ? markClozeAnswers(marked) : plain;
}

/** 把 `{{答案}}` 拆成挖空题面和填好的答案面。 */
function parseCloze(text) {
  const source = String(text ?? '').replaceAll(CLOZE_OPEN, '').replaceAll(CLOZE_CLOSE, '');
  CLOZE_PATTERN.lastIndex = 0;
  const protectedSource = maskMath(maskCode(source));
  const matches = [...protectedSource.matchAll(CLOZE_PATTERN)].filter(match => source.slice(match.index + 2, match.index + match[0].length - 2).trim());
  const answers = matches.map(match => source.slice(match.index + 2, match.index + match[0].length - 2).trim());
  const replace = fill => {
    let output = source;
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const match = matches[i];
      output = output.slice(0, match.index) + fill(answers[i]) + output.slice(match.index + match[0].length);
    }
    return output;
  };
  if (answers.length === 0) return { hasCloze: false, masked: source, filled: source, marked: source, answers: [] };

  return {
    hasCloze: true,
    masked: replace(() => '＿＿＿＿'),
    filled: replace(answer => answer),
    // 答案两侧夹上私用区字符，渲染成 HTML 以后再换成高亮标签（见 markClozeAnswers）。
    marked: replace(answer => `${CLOZE_OPEN}${answer}${CLOZE_CLOSE}`),
    answers
  };
}

/**
 * 卡片 ID 会被永久写进复习事件日志，所以必须稳定且可读。
 * 取「卡片文件相对 cards/ 的路径」+「正面文字」，比如 english/heterogeneity。
 *
 * 改了正面文字就等于换了一张卡，历史从头开始 —— 这是可预期的行为，
 * 比用行号（插一行就全乱）或随机 ID（人看不懂日志）都好。
 */
function cardId(cardPath, front) {
  const deckPath = stripExtension(toPosix(cardPath).replace(/^cards\//, ''));
  const text = String(front).trim().replace(/\s+/g, ' ');
  return text.includes('/') ? `v2:${JSON.stringify([deckPath, text])}` : `${deckPath}/${text}`;
}

/**
 * 给一份卡组里的卡分配 ID。
 *
 * 元数据里固定了 id 的卡（改过正面、挪过卡组）优先占住自己的 id；按正面文字
 * 算出来的 id 撞上它时，让算出来的那张加后缀。反过来的话，在它上面新写一张
 * 同旧正面的卡，就会把它的复习历史整个抢走。`taken` 是别的卡组文件里固定下来、
 * 归别人所有的 id，同样只能让。
 *
 * 其余规则和以前一样：同名的按出现顺序加 -2、-3，并且先把所有显式出现过的名字
 * 预留掉，后缀只落在没人占的位置上 —— 必须确定性，两台机器才能算出同一套 ID。
 */
function assignIds(bases, fixed, taken = new Set()) {
  const reserved = new Set([...bases, ...taken]);
  const used = new Set(taken);
  const result = new Array(bases.length);
  const nextSuffix = new Map();
  bases.forEach((base, index) => {
    if (fixed[index] && !used.has(base)) {
      result[index] = base;
      used.add(base);
    }
  });
  bases.forEach((base, index) => {
    if (result[index]) return;
    if (!used.has(base)) {
      result[index] = base;
      used.add(base);
      return;
    }
    let suffix = nextSuffix.get(base) || 2;
    let id;
    do { id = `${base}-${suffix++}`; } while (reserved.has(id) || used.has(id));
    nextSuffix.set(base, suffix);
    result[index] = id;
    used.add(id);
  });
  return result;
}

function deckFileOf(cardPath) {
  return stripExtension(toPosix(cardPath).replace(/^cards\//, ''));
}

function parseCardFile(cardPath, raw, { taken } = {}) {
  const parsed = parseFrontmatter(raw);
  const data = parsed.data || {};
  const deckFile = deckFileOf(cardPath);
  const deck = String(data.deck || deckFile).trim();
  const fileType = CARD_TYPES.includes(data.type) ? data.type : DEFAULT_TYPE;

  const cards = splitCards(parsed.content);
  const ids = assignIds(
    cards.map(card => card.meta.id || cardId(cardPath, card.idFront ?? card.front)),
    cards.map(card => Boolean(card.meta.id)),
    taken
  );
  const legacyIds = assignIds(
    cards.map(card => card.meta.legacy || deckFile + '/' + String(card.idFront ?? card.front).trim().replace(/\s+/g, ' ')),
    cards.map(card => Boolean(card.meta.legacy))
  );

  return cards.map((card, index) => {
    const cloze = parseCloze(card.back);
    return {
      id: ids[index],
      legacyId: legacyIds[index],
      blockIndex: index,
      suspended: Boolean(card.meta.suspended),
      pinned: Boolean(card.meta.id),
      deckFile,
      path: toPosix(cardPath),
      deck,
      type: cloze.hasCloze ? 'cloze' : fileType,
      front: card.front,
      back: card.back,
      question: cloze.hasCloze ? cloze.masked : '',
      answer: cloze.hasCloze ? cloze.filled : card.back,
      tags: Array.isArray(data.tags) ? data.tags.map(t => String(t).toLowerCase()) : []
    };
  });
}

/** 列出 vault 里所有卡片文件（cards/ 目录下的 .md）。 */
async function listCardFiles(vaultDir) {
  const cardsRoot = path.join(vaultDir, CARDS_DIR);
  const files = await listNotes(cardsRoot);
  return files.map(file => `${CARDS_DIR}/${file}`);
}

/**
 * 读出全部卡组，并算出「哪个固定 id 归哪个文件」：同一个固定 id 出现在两个文件里
 * （挪卡组中途中断、整块复制粘贴）时，排在前面的文件拥有它，另一份加后缀，
 * 两张卡的复习记录不会混在一起。
 */
async function loadDeckState(vaultDir, { onError = () => {} } = {}) {
  const files = [];
  for (const file of await listCardFiles(vaultDir)) {
    try {
      const { raw } = await readNote(vaultDir, file);
      files.push({ file, raw, blocks: splitCards(parseFrontmatter(raw).content) });
    } catch (error) {
      onError({ path: file, message: error.message });
    }
  }
  // 所有文件共用一次身份分配，固定身份优先；后缀也全局预留。
  const entries = files.flatMap(({ file, blocks }) => blocks.map(block => ({ file, block })));
  const ids = assignIds(
    entries.map(({ file, block }) => block.meta.id || cardId(file, block.idFront ?? block.front)),
    entries.map(({ block }) => Boolean(block.meta.id))
  );
  const takenFor = file => new Set(ids.filter((_, index) => entries[index].file !== file));
  const cards = [];
  for (const { file, raw } of files) {
    try {
      cards.push(...parseCardFile(file, raw, { taken: takenFor(file) }));
    } catch (error) {
      onError({ path: file, message: error.message });
    }
  }
  return { cards, takenFor };
}

async function loadAllCards(vaultDir, options = {}) {
  return (await loadDeckState(vaultDir, options)).cards;
}

/**
 * 背面里的二级标题会被 splitCards 当成下一张卡的正面：划词时选中了一段带
 * `## 方法` 的笔记，存进去就凭空多出一张以「方法」为正面的卡。这里把代码块
 * 以外的二级标题降成三级 —— 仍然是标题，只是不再是卡片分隔符。
 *
 * 划词也可能只选到代码块的一半：留下一个没闭合的围栏，splitCards 的围栏状态
 * 是整个文件共用的，之后追加的每一张卡都会被吞进这张卡的背面。所以末尾还在
 * 围栏里就补上闭合行，让每张卡的背面自成一体。
 */
function protectCardSeparators(text) {
  let fence = '';
  const lines = String(text ?? '').split('\n').map(line => {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = '';
      return line;
    }
    if (fence) return line;
    return line.replace(/^##(?=[ \t])/, '###');
  });
  if (fence) lines.push(fence);
  return lines.join('\n');
}

// ---------- 卡组文件的读写 ----------

function httpFailure(status, message) {
  return Object.assign(new Error(message), { status });
}

function normalizeFront(front) {
  const value = String(front ?? '').replace(/\s+/g, ' ').trim();
  if (!value) throw httpFailure(400, '卡片正面不能为空。');
  return value;
}

function normalizeDeckFile(deckFile) {
  // 不折叠重复的斜杠：`a//b` 这类非规范写法直接拒绝，和笔记路径的规则一致。
  const value = String(deckFile ?? '').trim().replaceAll('\\', '/').replace(/^cards\//, '').replace(/\.md$/i, '');
  if (!value || !isSafeRelativePath(`${CARDS_DIR}/${value}.md`)) throw httpFailure(400, '卡组文件名不合法。');
  // 列卡组时跳过点号开头的名字和 node_modules（见 listNotes）。写进去的卡片永远列不出来，
  // 接口却返回成功，所以在入口就拒绝。
  if (value.split('/').some(segment => segment.startsWith('.') || segment === 'node_modules')) {
    throw httpFailure(400, '卡组名不能以点号开头，也不能叫 node_modules。');
  }
  return value;
}

/**
 * 用户填的卡组名落到哪个文件。已有卡组按不区分大小写匹配：macOS 和 Windows 的
 * 磁盘默认不区分大小写，`English` 和 `english.md` 是同一个文件；Linux 上则会
 * 多出一个只差大小写的文件，同步到另外两台机器时互相覆盖。
 */
async function resolveDeckPath(vaultDir, deckFile) {
  const wanted = `${CARDS_DIR}/${normalizeDeckFile(deckFile)}.md`;
  const existing = (await listCardFiles(vaultDir)).find(file => file.toLowerCase() === wanted.toLowerCase());
  return existing || wanted;
}

/** 文件用的是哪种换行。新写进去的行跟着它走，不在一个文件里混用两种。 */
function lineEnding(raw) {
  return String(raw).includes('\r\n') ? '\r\n' : '\n';
}

/** 元数据行。JSON 里的 `>` 转义掉，正面写了 `-->` 也不会提前结束注释。 */
function renderMetaLine(meta) {
  const fields = {};
  if (meta.id) fields.id = meta.id;
  if (meta.legacy) fields.legacy = meta.legacy;
  if (meta.suspended) fields.suspended = true;
  if (!Object.keys(fields).length) return null;
  return `<!-- workstation:card:v1 ${JSON.stringify(fields).replace(/>/g, '\\u003e')} -->`;
}

/** 正面以「空格 + #」结尾时补一个收尾标记，否则那串 # 会被当成收尾标记吃掉。 */
function renderHeading(front) {
  return /[ \t]#+$/.test(front) ? `## ${front} #` : `## ${front}`;
}

function renderCardLines({ front, back, meta }) {
  const lines = [renderHeading(front)];
  const metaLine = renderMetaLine(meta);
  if (metaLine) lines.push(metaLine);
  lines.push('');
  const text = protectCardSeparators(trimBack(back));
  if (text) lines.push(...text.split('\n'));
  return lines;
}

/** 把卡组文件拆成 frontmatter 前缀和正文行（行尾的 \r 原样留着）。 */
function deckParts(raw) {
  const parsed = parseFrontmatter(raw);
  const body = parsed.content;
  if (!raw.endsWith(body)) throw httpFailure(409, '无法安全定位卡组正文。');
  return { prefix: raw.slice(0, raw.length - body.length), lines: body.split('\n'), blocks: splitCards(body), cr: lineEnding(raw) === '\r\n' ? '\r' : '' };
}

/**
 * 只改元数据行：暂停、恢复、固定 id 都走这里。标题和背面一个字节都不动 ——
 * 按解析结果整张重写会吃掉背面开头的缩进，`## C# #` 这种标题的 id 也会变。
 */
function setCardMeta(raw, index, meta) {
  const { prefix, lines, blocks, cr } = deckParts(raw);
  const block = blocks[index];
  const rendered = renderMetaLine(meta);
  if (block.metaLine >= 0) {
    if (rendered) lines[block.metaLine] = rendered + cr;
    else lines.splice(block.metaLine, 1);
  } else if (rendered) {
    lines.splice(block.start + 1, 0, rendered + cr);
  }
  return prefix + lines.join('\n');
}

/**
 * 把一张卡的那几行换成新内容（null 表示删除）。只动这张卡自己的行：别的卡里
 * 用户写的空行、代码块原样保留。一张卡的范围包括它后面到下一张卡之前的空行，
 * 所以新内容后面补一个空行，卡与卡之间仍然隔一行。
 */
function replaceCard(raw, index, replacement) {
  const { prefix, lines, blocks, cr } = deckParts(raw);
  const block = blocks[index];
  const before = lines.slice(0, block.start);
  const after = lines.slice(block.end);
  const middle = replacement ? [...replacement, ''].map(line => line + cr) : [];
  let body = [...before, ...middle, ...after].join('\n');
  if (!after.length) body = body.replace(/(?:\r?\n)*$/, cr + '\n');
  return prefix + body;
}

function appendCardLines(raw, lines) {
  const eol = lineEnding(raw);
  const before = raw.replace(/(?:\r?\n)*$/, eol) + eol;
  const result = before + lines.join(eol) + eol;
  const { prefix, blocks } = deckParts(result);
  const headingLine = before.slice(prefix.length).split('\n').length - 1;
  if (blocks.at(-1)?.start !== headingLine) {
    throw httpFailure(409, '无法识别新增的卡片，请检查卡组中未闭合的代码块。');
  }
  return result;
}

/**
 * 改完以后，别的卡的 id 不能跟着变。删掉两张同正面的卡里的第一张，第二张算出来
 * 的 id 就会从 X-2 变成 X，接手前一张的复习历史；在应用里改、删、挪卡时，这里
 * 把这类会变的 id 写进各自的元数据行固定住。expected 是改完后第 i 张卡应有的
 * id。
 */
function preserveIds(cardPath, raw, taken, expected) {
  let current = raw;
  for (let round = 0; round <= expected.length; round += 1) {
    const cards = parseCardFile(cardPath, current, { taken });
    if (cards.length !== expected.length) throw httpFailure(409, '无法识别预期的卡片，请检查卡组中未闭合的代码块。');
    const drift = expected.findIndex((want, index) => cards[index].id !== want.id || cards[index].legacyId !== want.legacyId);
    if (drift < 0) return current;
    const blocks = deckParts(current).blocks;
    const want = expected[drift];
    current = setCardMeta(current, drift, { ...blocks[drift].meta, id: want.id, legacy: want.legacyId });
  }
  throw httpFailure(409, '卡组里的卡片 ID 无法保持稳定，请检查重复的卡片后重试。');
}

async function locateCard(vaultDir, id) {
  const state = await loadDeckState(vaultDir);
  const card = state.cards.find(item => item.id === id);
  if (!card) throw httpFailure(404, '卡片不存在或已被删除，请刷新后重试。');
  return { card, takenFor: state.takenFor };
}

/** 在锁里重新读一遍文件，按 id 找到那张卡；外部改动让它不见了就报冲突。 */
async function readDeck(vaultDir, cardPath, taken, id) {
  const note = await readNote(vaultDir, cardPath);
  const cards = parseCardFile(cardPath, note.raw, { taken });
  const index = cards.findIndex(card => card.id === id);
  return { note, cards, index, card: cards[index] };
}

/**
 * 往卡组文件末尾追加一张卡。
 *
 * 只追加、不重排：卡片文件是给人读的 Markdown，程序不该擅自改动别的部分。
 */
async function appendCard(vaultDir, {
  deckFile = 'inbox', front, back = '', source = '', type = DEFAULT_TYPE, checkDuplicate = false
}) {
  // 正面必须是一行。卡片格式里它就是那个 `## 标题`，多行的话只有第一行算正面，
  // 剩下的会被 splitCards 当成背面 —— 于是「下面这句话问题在哪」的那句话
  // 跑到了答案面，翻开之前根本看不到题。这里压成一行，顺带和 cardId 的
  // 空白归一保持一致，保证写进文件的标题和算出来的 ID 对得上。
  const trimmedFront = String(front ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmedFront) throw new Error('卡片正面不能为空');

  // 路径校验放在唯一真正落盘的地方，而不是指望每个调用方各自记得。
  let relative;
  try {
    relative = await resolveDeckPath(vaultDir, deckFile);
  } catch (cause) {
    // 校验给出的具体原因（比如「不能以点号开头」）原样带出去。
    const error = new Error(cause?.status === 400 ? cause.message : '卡组文件名不合法');
    error.status = 400;
    throw error;
  }
  await fsp.mkdir(vaultDir, { recursive: true });
  await ensureSafeFilePath(vaultDir, relative, { allowMissing: true, createParents: true });

  const sourceLine = source ? `来自 [[${wikilinkTarget(source)}]]` : '';
  const backText = [protectCardSeparators(String(back).replace(/\r\n?/g, '\n').trim()), sourceLine].filter(Boolean).join('\n');
  const lines = [renderHeading(trimmedFront), '', ...(backText ? backText.split('\n') : [])];
  const resolvedType = CARD_TYPES.includes(type) ? type : DEFAULT_TYPE;

  // 交互建卡要在同一把库级锁内查重并追加，两次并发保存即使选了不同文件也能识别。
  const locks = checkDuplicate ? [CARDS_DIR, relative] : [relative];
  return enqueueFiles(vaultDir, locks, async () => {
    if (checkDuplicate) {
      const duplicate = (await loadAllCards(vaultDir)).find(card => card.front === trimmedFront && card.back === backText);
      if (duplicate) return { duplicate: true, deck: duplicate.deck };
    }
    let existing;
    try { existing = await readNote(vaultDir, relative); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const raw = existing
      ? appendCardLines(existing.raw, lines)
      : stringifyFrontmatter(`\n${lines.join('\n')}\n`, { deck: deckFileOf(relative), type: resolvedType });
    await writeNote(vaultDir, relative, { raw }, { exclusive: !existing });
    return { path: relative, front: trimmedFront, changed: true };
  });
}

// ---------- 在应用里编辑、删除、暂停、挪动卡片 ----------

/**
 * 改一张卡。front / back / suspended 不传就保持原样；deckFile 和当前文件不同时挪过去。
 *
 * 改了正面或挪了卡组，按正面算出的 id 就会变 —— 于是第一次这样改时把原来的 id
 * 写进元数据行，复习记录继续接在这张卡上。expectedHash 是卡组文件的版本，防止
 * 覆盖外部编辑；只切换暂停状态时可以不传，因为那只改元数据行，而且是在锁里重新
 * 读文件、按 id 找到卡之后才改的。
 */
async function updateCard(vaultDir, { id, expectedHash = '', front, back, deckFile, suspended }) {
  const wantedId = String(id ?? '');
  const { card: located, takenFor } = await locateCard(vaultDir, wantedId);
  const source = located.path;
  let target = deckFile === undefined || deckFile === '' ? source : await resolveDeckPath(vaultDir, deckFile);
  // 只差大小写、Unicode 写法不同的路径在不区分大小写的磁盘上是同一个文件：
  // 当成「挪到另一个文件」处理，会先追加再用旧内容覆盖回去，把卡弄丢。
  if (target !== source && await queueKey(vaultDir, target) === await queueKey(vaultDir, source)) target = source;
  const contentChange = front !== undefined || back !== undefined || target !== source;
  if (contentChange && !expectedHash) throw httpFailure(409, '缺少卡组版本，请刷新后重试。');

  return enqueueFiles(vaultDir, [source, target], async () => {
    const sourceTaken = takenFor(source);
    const current = await readDeck(vaultDir, source, sourceTaken, wantedId);
    if (expectedHash && current.note.hash !== expectedHash) throw httpFailure(409, '卡组文件已在别处修改，请刷新后重试。');
    if (!current.card) throw httpFailure(409, '卡片已被移动或删除，请刷新后重试。');
    const { card, cards, index, note } = current;
    const block = deckParts(note.raw).blocks[index];

    const nextFront = front === undefined ? card.front : normalizeFront(front);
    const nextBack = back === undefined ? card.back : trimBack(back);
    const meta = { ...block.meta };
    if (nextFront !== card.front || target !== source) {
      meta.id = card.id;
      meta.legacy = card.legacyId;
    }
    if (suspended !== undefined) meta.suspended = Boolean(suspended);
    const keepIds = cards.map(item => ({ id: item.id, legacyId: item.legacyId }));

    if (target === source) {
      const edited = nextFront === card.front && nextBack === card.back
        ? setCardMeta(note.raw, index, meta)
        : replaceCard(note.raw, index, renderCardLines({ front: nextFront, back: nextBack, meta }));
      const raw = preserveIds(source, edited, sourceTaken, keepIds);
      const written = await writeNote(vaultDir, source, { raw });
      return { id: card.id, path: source, hash: written.hash };
    }

    const remaining = keepIds.filter((_, position) => position !== index);
    const sourceRaw = preserveIds(source, replaceCard(note.raw, index, null), new Set([...sourceTaken, meta.id]), remaining);

    // 挪卡组：先写进新文件，再从旧文件删掉。中途失败最多留下两份，不会丢卡。
    const lines = renderCardLines({ front: nextFront, back: nextBack, meta });
    const targetTaken = new Set([...takenFor(target)].filter(item => item !== meta.id));
    await ensureSafeFilePath(vaultDir, target, { allowMissing: true, createParents: true });
    let existing;
    try { existing = await readNote(vaultDir, target); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const before = existing ? parseCardFile(target, existing.raw, { taken: targetTaken }) : [];
    const combined = existing
      ? appendCardLines(existing.raw, lines)
      : stringifyFrontmatter(`\n${lines.join('\n')}\n`, { deck: deckFileOf(target), type: DEFAULT_TYPE });
    const targetRaw = preserveIds(target, combined, targetTaken, [...before, card]);
    await writeNote(vaultDir, target, { raw: targetRaw }, { exclusive: !existing });

    // 目标写好以后重新读一遍源文件再删：不拿挪动前读到的旧内容覆盖回去。
    const reread = await readNote(vaultDir, source);
    if (reread.hash !== note.hash) {
      throw httpFailure(409, '卡片已复制到新卡组，但原卡组在这期间被修改，原来那张没有删除，请检查后手动删掉。');
    }
    // 挪走以后这个 id 归目标文件所有：源文件里同正面的卡不能再把它算回来。
    const written = await writeNote(vaultDir, source, { raw: sourceRaw });
    return { id: meta.id, path: target, hash: written.hash };
  });
}

async function deleteCard(vaultDir, { id, expectedHash = '' }) {
  const wantedId = String(id ?? '');
  const { card: located, takenFor } = await locateCard(vaultDir, wantedId);
  const source = located.path;
  if (!expectedHash) throw httpFailure(409, '缺少卡组版本，请刷新后重试。');
  return enqueueFile(vaultDir, source, async () => {
    const taken = takenFor(source);
    const { note, card, cards, index } = await readDeck(vaultDir, source, taken, wantedId);
    if (note.hash !== expectedHash) throw httpFailure(409, '卡组文件已在别处修改，请刷新后重试。');
    if (!card) throw httpFailure(409, '卡片已被移动或删除，请刷新后重试。');
    const remaining = cards.filter((_, position) => position !== index).map(item => ({ id: item.id, legacyId: item.legacyId }));
    const raw = preserveIds(source, replaceCard(note.raw, index, null), taken, remaining);
    // 删卡前的整份卡组单独记成 card：60 天内全留，更早的每天留最早一份（见 history.js）。
    const written = await writeNote(vaultDir, source, { raw }, { versionReason: 'card' });
    return { path: source, hash: written.hash };
  });
}

/** 卡组文件和它们的卡组名，供编辑页选择「挪到哪个卡组」。 */
async function listDeckFiles(vaultDir) {
  const decks = [];
  for (const file of await listCardFiles(vaultDir)) {
    const name = stripExtension(file.replace(/^cards\//, ''));
    let deck = name;
    try { deck = String(parseFrontmatter((await readNote(vaultDir, file)).raw).data?.deck || name).trim(); } catch {}
    decks.push({ file: name, deck });
  }
  return decks;
}

module.exports = {
  CARDS_DIR,
  CARD_TYPES,
  appendCard,
  DEFAULT_TYPE,
  splitCards,
  parseCloze,
  markClozeAnswers, renderClozeAnswer,
  cardId,
  parseCardFile,
  listCardFiles,
  loadAllCards,
  updateCard,
  deleteCard,
  listDeckFiles,
  renderCardLines,
  resolveDeckPath
};
