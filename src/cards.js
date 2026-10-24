const path = require('node:path');

const { toPosix, stripExtension, isSafeRelativePath, ensureSafeFilePath } = require('./vault/paths');
const { listNotes, parseFrontmatter, stringifyFrontmatter, readNote, writeNote } = require('./vault/note');
const { enqueueFile } = require('./vault/note-queue');
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
 */
function splitCards(body) {
  const lines = String(body ?? '').split('\n');
  const cards = [];
  let current = null;
  let fence = '';

  for (const line of lines) {
    // 代码块里的 ## 是注释或标题语法，不是卡片分隔符。
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = '';
    }

    if (!fence && /^\s*<!--\s*workstation:annotation-card:v1\s+.*-->\s*$/.test(line)) continue;

    // CommonMark 里结尾的 `#` 只有前面有空白时才算收尾标记，所以 `## C#` 的
    // 标题是「C#」而不是「C」。
    const heading = fence ? null : line.match(/^##[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/);
    if (heading) {
      if (current) cards.push(current);
      current = {
        front: heading[1].trim(),
        // 旧版本把 `## C#` 读成了「C」，并用它算出卡片 ID 写进了复习日志。
        // ID 必须沿用旧算法，否则这些卡的复习历史会在升级后全部断掉。
        idFront: line.match(/^##[ \t]+(.+?)[ \t]*#*[ \t]*$/)[1].trim(),
        backLines: []
      };
    } else if (current) {
      current.backLines.push(line);
    }
  }
  if (current) cards.push(current);

  return cards.map(card => ({
    front: card.front,
    idFront: card.idFront,
    back: card.backLines.join('\n').trim()
  }));
}

/** 把 `{{答案}}` 拆成挖空题面和填好的答案面。 */
function parseCloze(text) {
  const source = String(text ?? '');
  CLOZE_PATTERN.lastIndex = 0;
  const answers = [...source.matchAll(CLOZE_PATTERN)].map(match => match[1].trim());
  if (answers.length === 0) return { hasCloze: false, masked: source, filled: source, answers: [] };

  return {
    hasCloze: true,
    masked: source.replace(CLOZE_PATTERN, '＿＿＿＿'),
    filled: source.replace(CLOZE_PATTERN, (match, answer) => answer.trim()),
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

function uniqueIds(bases) {
  const reserved = new Set(bases);
  const seenBases = new Set();
  const used = new Set();
  const nextSuffix = new Map();
  return bases.map(base => {
    let id = base;
    if (seenBases.has(base)) {
      let suffix = nextSuffix.get(base) || 2;
      do { id = `${base}-${suffix++}`; } while (reserved.has(id) || used.has(id));
      nextSuffix.set(base, suffix);
    } else {
      seenBases.add(base);
      nextSuffix.set(base, 2);
    }
    used.add(id);
    return id;
  });
}

function parseCardFile(cardPath, raw) {
  const parsed = parseFrontmatter(raw);
  const data = parsed.data || {};
  const deck = String(data.deck || stripExtension(toPosix(cardPath).replace(/^cards\//, ''))).trim();
  const fileType = CARD_TYPES.includes(data.type) ? data.type : DEFAULT_TYPE;

  const cards = splitCards(parsed.content);

  // 同一文件里正面重复时确定性地加后缀，避免两张卡抢同一个 ID。
  // 必须是确定性的，否则两台机器算出的 ID 不同，事件日志就对不上了。
  //
  // 分两趟走，是因为只记「加后缀前的名字」不够：文件里同时有两个 `## A` 和一个
  // `## A-2` 时，第二个 A 会被排成 A-2，跟真正的 A-2 撞在一起 —— 而 ID 撞了
  // 意味着 replay 把两张卡的复习历史喂进同一个 FSRS 状态机，排期直接算错。
  // 先把所有显式出现过的名字预留掉，后缀就只会落在没人占的位置上，
  // 同 markdown.js 里给重复标题分配锚点的做法。
  const bases = cards.map(card => cardId(cardPath, card.idFront ?? card.front));
  const ids = uniqueIds(bases);
  const legacyIds = uniqueIds(cards.map(card => {
    const deckPath = stripExtension(toPosix(cardPath).replace(/^cards\//, ''));
    return deckPath + '/' + String(card.idFront ?? card.front).trim().replace(/\s+/g, ' ');
  }));

  return cards.map((card, index) => {
    const cloze = parseCloze(card.back);
    const id = ids[index];

    return {
      id,
      legacyId: legacyIds[index],
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

async function loadAllCards(vaultDir, { onError = () => {} } = {}) {
  const files = await listCardFiles(vaultDir);
  const cards = [];
  for (const file of files) {
    try {
      const { raw } = await readNote(vaultDir, file);
      cards.push(...parseCardFile(file, raw));
    } catch (error) {
      onError({ path: file, message: error.message });
    }
  }
  return cards;
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

/**
 * 往卡组文件末尾追加一张卡。
 *
 * 只追加、不重排：卡片文件是给人读的 Markdown，程序不该擅自改动别的部分。
 */
async function appendCard(vaultDir, {
  deckFile = 'inbox', front, back = '', source = '', type = DEFAULT_TYPE, managedId = ''
}) {
  // 正面必须是一行。卡片格式里它就是那个 `## 标题`，多行的话只有第一行算正面，
  // 剩下的会被 splitCards 当成背面 —— 于是「下面这句话问题在哪」的那句话
  // 跑到了答案面，翻开之前根本看不到题。这里压成一行，顺带和 cardId 的
  // 空白归一保持一致，保证写进文件的标题和算出来的 ID 对得上。
  const trimmedFront = String(front ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmedFront) throw new Error('卡片正面不能为空');

  // 路径校验放在这里，而不是指望每个调用方各自记得。
  // 三个建卡入口里原先只有两个查了 isSafeRelativePath，第三个（标注处理）
  // 自己写了个正则，会放过 con/aux/nul 这类 Windows 设备名和前导斜杠。
  // 同一个概念有两套尺子迟早会漏，收到唯一真正落盘的地方来把关。
  const relative = `${CARDS_DIR}/${String(deckFile).replace(/\.md$/i, '')}.md`;
  if (!isSafeRelativePath(relative)) {
    const error = new Error('卡组文件名不合法');
    error.status = 400;
    throw error;
  }
  await fsp.mkdir(vaultDir, { recursive: true });
  await ensureSafeFilePath(vaultDir, relative, { allowMissing: true, createParents: true });

  const sourceLine = source ? `\n来自 [[${String(source).replace(/\.md$/i, '')}]]` : '';
  const managedMarker = managedId
    ? `<!-- workstation:annotation-card:v1 ${JSON.stringify({ id: String(managedId) })} -->\n`
    : '';
  const block = `\n${managedMarker}## ${trimmedFront}\n\n${protectCardSeparators(String(back).trim())}${sourceLine}\n`;
  const resolvedType = CARD_TYPES.includes(type) ? type : DEFAULT_TYPE;
  const initial = stringifyFrontmatter(block, { deck: deckFile, type: resolvedType });

  const changed = await enqueueFile(vaultDir, relative, async () => {
    let existing;
    try { existing = await readNote(vaultDir, relative); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && managedMarker && existing.raw.includes(managedMarker.trim())) return false;
    await writeNote(vaultDir, relative, { raw: existing ? existing.raw + block : initial }, { exclusive: !existing });
    return true;
  });

  return { path: relative, front: trimmedFront, changed };
}

module.exports = {
  CARDS_DIR,
  CARD_TYPES,
  appendCard,
  DEFAULT_TYPE,
  splitCards,
  parseCloze,
  cardId,
  parseCardFile,
  listCardFiles,
  loadAllCards
};
