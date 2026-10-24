const path = require('node:path');
const { Worker } = require('node:worker_threads');

const { buildIndex, similarTo, linkSuggestions, retrieve } = require('./similarity');

const WORKER_FILE = path.join(__dirname, 'similarity-worker.js');

/**
 * 相似度服务：把建索引和链接建议挪出主线程。
 *
 * 主线程这边只做两件轻活：从 SQLite 取笔记的 path+hash 算增量，以及把结果交给
 * 路由。分词、TF-IDF、两两比较都在工作线程里跑，所以「知识库体检」再慢也只是
 * 那一个请求慢，不会把保存、检索和同步一起拖住。
 *
 * 工作线程起不来时退化成主线程内联计算 —— 打包环境千奇百怪，宁可慢也不能让
 * 相似笔记、链接建议和资料问答中的笔记检索整个消失。
 */
function createSimilarityService({ db, logger = console, useWorker = true } = {}) {
  let worker = null;
  // useWorker: false 就一直走内联计算。测试和直接构造 app 的调用方用得上 ——
  // 它们不需要为几十毫秒的计算去管一个线程的生命周期。
  let workerBroken = !useWorker;
  let sequence = 0;
  let failures = 0;
  let shuttingDown = false;
  const pending = new Map();

  // 连续崩这么多次就彻底改走内联。
  //
  // 原来 workerBroken 只在 `new Worker()` 同步抛错时才置位：线程能起来但一跑就崩
  // （打包环境缺依赖、ABI 对不上）的话，每个请求都会重新拉起一个必然再崩的线程，
  // 永远降不了级。功能上不受影响（每次都会退回内联算），但白烧资源、刷满日志，
  // 而且掩盖了「工作线程在这台机器上根本用不了」这个事实。
  const FAILURE_LIMIT = 3;

  // 主线程记着「上次发给工作线程的是哪些 path→hash」，据此算增量。
  // 只取 path 和 hash，不取正文，所以这一步很便宜。
  let mirror = new Map();

  // 内联兜底用的缓存，和工作线程里那份是同一套逻辑。
  let inlineCache = { signature: '', index: null };
  const inlineTokenCache = new Map();

  /**
   * 空闲时把线程 unref 掉，有请求在飞时 ref 回来。
   *
   * 一直 ref 会让应用退不干净（一个闲着的线程也算「还有事要做」）；一直 unref
   * 则会让进程在等结果的过程中直接退出 —— 主循环没有别的东西吊着时，
   * 那个 await 永远不会返回。所以只在真的有活儿的时候持有引用。
   */
  function releaseWhenIdle() {
    if (worker && pending.size === 0) worker.unref();
  }

  function spawn() {
    if (worker || workerBroken) return worker;
    try {
      worker = new Worker(WORKER_FILE);
    } catch (error) {
      workerBroken = true;
      logger.warn?.(`[similarity] 工作线程起不来，改为主线程计算：${error.message}`);
      return null;
    }

    // 每个线程实例只记一次故障：error 事件后紧跟着还会来一个非零 exit，
    // 两个都计数的话崩两次就到上限，会把偶发问题误判成「这台机器用不了线程」。
    let failed = false;

    worker.on('message', message => {
      // 拿到过结果就说明这个线程是好的，之前那几次是偶发，计数归零。
      failures = 0;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error));
      releaseWhenIdle();
    });

    const fail = error => {
      if (failed) return;
      failed = true;
      // 线程挂了：让在飞的请求全部失败，并把镜像清空 —— 新线程是空的，
      // 下次必须整份重发，否则它会拿着不完整的文档集算出错误结果。
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      mirror = new Map();
      worker = null;
      // close() 主动 terminate 出来的非零退出不算故障。
      if (shuttingDown) return;
      failures += 1;
      if (failures >= FAILURE_LIMIT) {
        workerBroken = true;
        logger.warn?.(`[similarity] 工作线程连续 ${failures} 次异常退出，之后一律在主线程计算。`);
      }
    };

    worker.on('error', error => {
      logger.warn?.(`[similarity] 工作线程出错：${error.message}`);
      fail(error);
    });
    worker.on('exit', code => {
      if (code !== 0) fail(new Error(`相似度工作线程退出（code ${code}）`));
      // 正常退出也要清镜像：下一个线程是空的，留着旧镜像会让增量只发「变过的那几篇」，
      // 新线程于是拿着一份残缺文档集去算相似度 —— 不报错，只是结果悄悄是错的。
      else if (!failed) { worker = null; mirror = new Map(); }
    });

    releaseWhenIdle();
    return worker;
  }

  /** 算出相对上次发送的增量：内容变了的要重发，删掉的要通知。 */
  function buildDelta() {
    const rows = db.raw.prepare(`SELECT path, hash FROM notes`).all();
    const next = new Map(rows.map(row => [row.path, row.hash]));

    const changed = [];
    for (const [notePath, hash] of next) {
      if (mirror.get(notePath) !== hash) changed.push(notePath);
    }
    const removedPaths = [...mirror.keys()].filter(notePath => !next.has(notePath));

    let upserts = [];
    if (changed.length) {
      // 只把真正变了的那几篇的正文捞出来。全量重发在 3000 篇时是几 MB 的
      // 结构化克隆，而绝大多数请求之间只动了一两篇。
      const placeholders = changed.map(() => '?').join(',');
      upserts = db.raw.prepare(`
        SELECT path, title_raw AS title, body_raw AS body, hash
        FROM notes WHERE path IN (${placeholders})
      `).all(...changed);
    }

    return { upserts, removedPaths, next };
  }

  function send(type, payload) {
    const active = spawn();
    if (!active) return null;

    const { upserts, removedPaths, next } = buildDelta();
    const id = (sequence += 1);

    let delivered = false;
    const promise = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      // 有请求在飞，线程必须吊住事件循环，否则进程会在等结果时直接退出。
      active.ref();
      try {
        active.postMessage({ id, type, upserts, removedPaths, ...payload });
        delivered = true;
      } catch (error) {
        pending.delete(id);
        releaseWhenIdle();
        reject(error);
      }
    });

    // 只有确认发出去了才更新镜像。发送本身抛错的话镜像必须保持原样，
    // 否则下次算出来的增量会漏掉这批改动。
    // （executor 是同步跑的，走到这里 delivered 已经定了。）
    if (delivered) mirror = next;
    return promise;
  }

  /** 主线程内联计算，只在工作线程不可用时走到。 */
  function inlineIndex() {
    // 时间戳可能被保留，也可能小于另一篇笔记的时间；和 worker 一样按 path+hash
    // 判断变化。固定顺序并用 JSON 编码，重命名或路径中的分隔符也不会漏判。
    const rows = db.raw.prepare(`SELECT path, hash FROM notes ORDER BY path`).all();
    const signature = JSON.stringify(rows);
    if (signature !== inlineCache.signature) {
      // 使用 worker 的 JS 字符串比较规则；SQLite 对非 BMP 路径的排序不同，
      // 会让同分结果在降级后改变顺序，甚至改变 limit 截取的结果。
      const documents = db.raw.prepare(`
        SELECT path, title_raw AS title, body_raw AS body, hash FROM notes
      `).all().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      inlineCache = { signature, index: buildIndex(documents, { cache: inlineTokenCache }) };
    }
    return inlineCache.index;
  }

  async function run(type, payload, inline) {
    const promise = send(type, payload);
    if (promise) {
      try {
        return await promise;
      } catch (error) {
        logger.warn?.(`[similarity] 工作线程请求失败，改为主线程计算：${error.message}`);
      }
    }
    return inline();
  }

  return {
    suggestions(links, options = {}) {
      return run('suggestions', { links, options }, () => ({
        suggestions: linkSuggestions(inlineIndex(), links, options)
      }));
    },

    similar(notePath, options = {}) {
      return run('similar', { notePath, options }, () => ({
        results: similarTo(inlineIndex(), notePath, options)
      }));
    },

    retrieve(query, options = {}) {
      return run('retrieve', { query, options }, () => ({
        results: retrieve(inlineIndex(), query, options)
      }));
    },

    async close() {
      shuttingDown = true;
      const active = worker;
      worker = null;
      // 在飞的请求要显式失败掉。光 clear 的话它们的 promise 永远不会 settle，
      // 等在上面的调用方就一直挂着 —— 退出流程里没人再去唤醒它。
      const closed = new Error('相似度服务已关闭。');
      for (const entry of pending.values()) entry.reject(closed);
      pending.clear();
      mirror = new Map();
      if (active) await active.terminate();
    }
  };
}

module.exports = { createSimilarityService };
