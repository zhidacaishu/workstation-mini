const { LEXICAL_STOPWORDS: STOPWORDS, tokenize } = require('./segment');

/**
 * 平滑过的 IDF。
 *
 * 朴素的 `log(total / df)` 在小语料上会塌成 0：一个词如果出现在**所有**笔记里，
 * df === total，权重直接归零。vault 刚建起来只有几篇笔记时，几乎每个词都是这种
 * 情况，于是所有向量都变成空的，相似度恒等于 0 —— 功能看起来「没坏」，只是永远
 * 什么都不返回。
 *
 * 加一的平滑保证权重恒为正，常见词权重低但不消失，小语料照样能用。
 */
function idf(df, total) {
  return Math.log((total + 1) / (df + 1)) + 1;
}

function termFrequency(text) {
  const counts = new Map();
  for (const token of tokenize(text)) {
    if (token.length < 2 && !/[一-鿿]/.test(token)) continue;
    if (STOPWORDS.has(token)) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

/**
 * 词法相似度（TF-IDF + 余弦）。
 *
 * **刻意不叫「语义检索」**：真正的语义检索要嵌入模型，而嵌入要么调外部 API、
 * 要么在本地跑模型 —— 前者需要凭据和网络，后者这台 1 核机器扛不住。
 * TF-IDF 是纯本地、零依赖、离线可用的，对「这两篇讲的是不是一回事」这个问题
 * 已经相当够用。把它标成语义检索是在夸大它做不到的事。
 *
 * 想升级成真正的向量检索时，把 similarNotes 换掉即可，调用方不用动。
 */
/**
 * @param {object} [options]
 * @param {Map} [options.cache] 按 `path` 缓存分词结果，用 `hash` 判断是否还有效。
 *   分词占了建索引的绝大部分时间，而一次编辑只会让**一篇**笔记的分词失效。
 *   没有缓存的话，改一个字就要把整个 vault 重新分一遍词。
 */
function buildIndex(documents, options = {}) {
  const cache = options.cache || null;

  const frequencies = documents.map(doc => {
    // 没有 hash 就不敢用缓存：认不出内容变没变，只能老实重算。
    if (cache && doc.hash) {
      const hit = cache.get(doc.path);
      if (hit && hit.hash === doc.hash) return hit.counts;
    }
    const counts = termFrequency(`${doc.title}\n${doc.body}`);
    if (cache && doc.hash) cache.set(doc.path, { hash: doc.hash, counts });
    return counts;
  });

  // 删掉的笔记要从缓存里清出去，否则它会一直占着内存到进程退出。
  if (cache && cache.size > documents.length) {
    const alive = new Set(documents.map(doc => doc.path));
    for (const key of cache.keys()) {
      if (!alive.has(key)) cache.delete(key);
    }
  }

  const documentFrequency = new Map();

  for (const counts of frequencies) {
    for (const term of counts.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }

  const total = documents.length || 1;
  const makeVector = (counts, minimumDocumentFrequency) => {
    const vector = new Map();
    let norm = 0;
    for (const [term, count] of counts) {
      const df = documentFrequency.get(term) || 1;
      if (df < minimumDocumentFrequency) continue;
      const weight = (1 + Math.log(count)) * idf(df, total);
      if (weight <= 0) continue;
      vector.set(term, weight);
      norm += weight * weight;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [term, weight] of vector) vector.set(term, weight / norm);
    return vector;
  };

  // 只在一篇里出现的词对「找相似」没有帮助，反而放大噪声；但它可能正是
  // 用户检索的精确术语，所以检索使用保留全部词的独立向量。
  const vectors = frequencies.map(counts => makeVector(counts, 2));
  const retrievalVectors = frequencies.map(counts => makeVector(counts, 1));

  return { documents, vectors, retrievalVectors, documentFrequency, total };
}

function cosine(a, b) {
  // 遍历较短的那个向量，长文档配短文档时能省不少。
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [term, weight] of small) {
    const other = large.get(term);
    if (other) sum += weight * other;
  }
  return sum;
}

/** 与某篇笔记最相似的若干篇。 */
function similarTo(index, notePath, { limit = 8, minScore = 0.08 } = {}) {
  const position = index.documents.findIndex(doc => doc.path === notePath);
  if (position === -1) return [];

  const target = index.vectors[position];
  const scored = [];
  for (let i = 0; i < index.documents.length; i += 1) {
    if (i === position) continue;
    const score = cosine(target, index.vectors[i]);
    if (score >= minScore) {
      scored.push({ path: index.documents[i].path, title: index.documents[i].title, score });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 升序数组里第一个大于 target 的位置。倒排表按文档序号递增排列，用它跳过前半段。 */
function upperBound(sorted, target) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] > target) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * 链接建议：内容相似但**还没连起来**的两篇。
 *
 * 已经连过的不再建议 —— 那是噪声。这个功能的价值全在于指出你自己没注意到的关联。
 *
 * 这里有两条等价路径，结果逐位相同，只是快慢取决于 vault 的用词分布：
 *
 *   - **两两比较**：老老实实算 N²/2 次余弦。每对的开销小，但对数是死的。
 *   - **倒排表**：只枚举真正共享词的文档对。共享一个词都没有的两篇余弦恒为 0，
 *     而 0 永远过不了 minScore，那些配对本来就是白算的。
 *
 * 反直觉的地方在于倒排表**不是**总更快：如果一个 vault 高度聚焦（几百篇都在写
 * 同一个领域，用词大量重叠），几乎每对文档都共享词，倒排表既省不掉配对，
 * 每次累加还比一次 Map.get 贵，实测反而慢 3 倍。主题分散的 vault 上则快 2 倍多。
 *
 * 所以先估工作量再挑路径，而不是赌某一条永远更好。
 */
// 倒排表的一次累加（Map.get + Map.set + 边界二分）比 cosine 里一次 Map.get 贵得多。
// 实测三种用词分布下的「工作量比 pairwiseWork/invertedWork」与实际快慢：
//   聚焦领域 1.5 → 倒排慢 3.4 倍｜中等 4.2 → 倒排慢 1.5 倍｜主题分散 11.2 → 倒排快 2.1 倍
// 阈值取 6，落在 4.2 和 11.2 中间：只有倒排明显划算时才走它，其余情况走可预测的两两比较。
const INVERTED_OP_PENALTY = 6;

function buildPostings(vectors) {
  // 词 → 含有这个词的文档序号（天然递增，因为是按 i 递增填进去的）。
  const postings = new Map();
  for (let i = 0; i < vectors.length; i += 1) {
    for (const term of vectors[i].keys()) {
      let list = postings.get(term);
      if (!list) {
        list = [];
        postings.set(term, list);
      }
      list.push(i);
    }
  }
  return postings;
}

function linkSuggestions(index, existingLinks, { limit = 20, minScore = 0.12 } = {}) {
  const linked = new Set();
  for (const link of existingLinks) {
    linked.add(`${link.from}\0${link.to}`);
    linked.add(`${link.to}\0${link.from}`);
  }

  const count = index.vectors.length;
  const postings = buildPostings(index.vectors);

  // 倒排表要做的累加次数：每个词把它出现过的文档两两配一次。
  let invertedWork = 0;
  let totalTerms = 0;
  for (const list of postings.values()) {
    invertedWork += (list.length * (list.length - 1)) / 2;
    totalTerms += list.length;
  }
  // 两两比较要做的 Map.get 次数：配对数 × 平均向量长度。
  const pairwiseWork = (count * (count - 1)) / 2 * (totalTerms / (count || 1));
  const useInverted = invertedWork * INVERTED_OP_PENALTY < pairwiseWork;

  const suggestions = [];
  const keep = (i, j, score) => {
    if (score < minScore) return;
    const a = index.documents[i];
    const b = index.documents[j];
    if (linked.has(`${a.path}\0${b.path}`)) return;
    suggestions.push({ a: { path: a.path, title: a.title }, b: { path: b.path, title: b.title }, score });
  };

  if (useInverted) {
    const scores = new Map();
    for (let i = 0; i < count; i += 1) {
      scores.clear();
      for (const [term, weight] of index.vectors[i]) {
        const list = postings.get(term);
        if (!list) continue;
        // 只看 j > i：每对文档算一次就够了。
        for (let k = upperBound(list, i); k < list.length; k += 1) {
          const j = list[k];
          scores.set(j, (scores.get(j) || 0) + weight * index.vectors[j].get(term));
        }
      }
      for (const [j, score] of scores) keep(i, j, score);
    }
  } else {
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        keep(i, j, cosine(index.vectors[i], index.vectors[j]));
      }
    }
  }

  return suggestions.sort((x, y) => y.score - x.score).slice(0, limit);
}

/** 检索：给一段查询找最相关的笔记片段，供问答引用。 */
function retrieve(index, query, { limit = 6, minScore = 0.05 } = {}) {
  const counts = termFrequency(query);
  const vector = new Map();
  let norm = 0;
  for (const [term, count] of counts) {
    const df = index.documentFrequency.get(term);
    if (!df) continue;
    const weight = (1 + Math.log(count)) * idf(df, index.total);
    if (weight <= 0) continue;
    vector.set(term, weight);
    norm += weight * weight;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [term, weight] of vector) vector.set(term, weight / norm);
  if (vector.size === 0) return [];

  return index.documents
    .map((doc, i) => ({ ...doc, score: cosine(vector, index.retrievalVectors[i]) }))
    .filter(doc => doc.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * 知识库体检。
 *
 * 找出那些「记了但从没被再看过」的坑：孤岛笔记、只有标题没正文的空壳、
 * 长期没整理的 inbox。这些不是错误，是提醒。
 */
function healthCheck(db, { emptyThreshold = 80 } = {}) {
  const notes = db.raw.prepare(`
    SELECT path, title_raw AS title, body_raw AS body, section, mtime_ms AS mtimeMs FROM notes
  `).all();

  const linkedPaths = new Set();
  for (const row of db.raw.prepare(`SELECT from_path, to_path FROM links WHERE to_path != ''`).all()) {
    linkedPaths.add(row.from_path);
    linkedPaths.add(row.to_path);
  }

  const stripped = note => note.body.replace(/^#.*$/gm, '').replace(/\s/g, '');

  return {
    total: notes.length,
    orphans: notes.filter(note => !linkedPaths.has(note.path))
      .map(note => ({ path: note.path, title: note.title })),
    stubs: notes.filter(note => stripped(note).length < emptyThreshold)
      .map(note => ({ path: note.path, title: note.title, length: stripped(note).length })),
    // 待建链接：指向还没写的笔记，写出来就能接上。
    pending: db.raw.prepare(`
      SELECT to_target AS target, count(*) AS count FROM links
      WHERE to_path = '' GROUP BY to_target ORDER BY count DESC, to_target LIMIT 20
    `).all()
  };
}

module.exports = {
  STOPWORDS, termFrequency, buildIndex, cosine,
  similarTo, linkSuggestions, retrieve, healthCheck
};
