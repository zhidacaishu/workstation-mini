const { parentPort } = require('node:worker_threads');

const { buildIndex, similarTo, linkSuggestions, retrieve } = require('./similarity');

/**
 * 相似度计算的工作线程。
 *
 * 这里跑的是全应用最重的两段 CPU：给整个 vault 分词建 TF-IDF 索引，以及
 * 两两比较找链接建议。它们在主线程上分别要几秒和几十秒，期间保存笔记、检索、
 * Git 同步全部排队 —— Node 是单线程的，一个知识库体检请求能把整个应用冻住。
 *
 * 线程里自带两级缓存：
 *   - `documents` 是文档全量副本，主线程只发增量，不用每次传几 MB 过来；
 *   - `tokenCache` 按 path+hash 缓存分词，改一篇笔记只让那一篇失效。
 */
const documents = new Map();
const tokenCache = new Map();

let index = null;
let indexDirty = true;
// 索引每重建一次就加一。链接建议是纯函数（同一份索引 + 同一组参数 → 同一批结果），
// 所以用它当缓存键：笔记没动就直接复用上次算好的。
let indexVersion = 0;
let suggestionsCache = null;

function currentIndex() {
  if (indexDirty || !index) {
    indexVersion += 1;
    // Map 的插入顺序是稳定的，但排一下序更保险：similarTo / linkSuggestions
    // 都按下标引用文档，顺序抖动会让结果在无关的重建之间跳来跳去。
    const ordered = [...documents.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([path, doc]) => ({ path, title: doc.title, body: doc.body, hash: doc.hash }));
    index = buildIndex(ordered, { cache: tokenCache });
    indexDirty = false;
  }
  return index;
}

function applySync(message) {
  for (const path of message.removedPaths || []) {
    if (documents.delete(path)) indexDirty = true;
  }
  for (const doc of message.upserts || []) {
    documents.set(doc.path, { title: doc.title, body: doc.body, hash: doc.hash });
    indexDirty = true;
  }
}

function handle(message) {
  applySync(message);

  switch (message.type) {
    case 'sync':
      return { notes: documents.size };
    case 'suggestions': {
      // 链接建议是这里最贵的一段（大 vault 上以分钟计）。它只随笔记内容变，
      // 所以笔记没动时重复打开体检页不该重算 —— 现在是秒开。
      //
      // 键里不放 links：双链本身就是从这批笔记正文里解析出来的派生数据，
      // 笔记没变它就不会变，indexVersion 已经覆盖了。
      const options = message.options || {};
      const active = currentIndex();
      const key = `${indexVersion}|${options.limit ?? ''}|${options.minScore ?? ''}`;
      if (!suggestionsCache || suggestionsCache.key !== key) {
        suggestionsCache = { key, value: linkSuggestions(active, message.links || [], options) };
      }
      return { notes: documents.size, suggestions: suggestionsCache.value };
    }
    case 'similar':
      return { results: similarTo(currentIndex(), message.notePath, message.options || {}) };
    case 'retrieve':
      return { results: retrieve(currentIndex(), message.query, message.options || {}) };
    default:
      throw new Error(`未知的相似度请求：${message.type}`);
  }
}

parentPort.on('message', message => {
  try {
    parentPort.postMessage({ id: message.id, ok: true, result: handle(message) });
  } catch (error) {
    parentPort.postMessage({ id: message.id, ok: false, error: error.message });
  }
});
