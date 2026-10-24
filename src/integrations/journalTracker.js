/**
 * journal-tracker 的待读队列。
 *
 * 它已经是一个带 JWT、调度器和邮件推送的完整服务，所以工作台只做「读取端」：
 * 拉 /api/papers 展示待读，写笔记时反链回去。不把它合并进来。
 */

const DEFAULT_TIMEOUT = 5000;

function normalizeHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? raw : '';
  } catch {
    return '';
  }
}

/**
 * 拼接接口地址，保住 baseUrl 里的路径前缀。
 *
 * `new URL('/api/login', 'https://x.com/tracker')` 解析到 origin 根，得到
 * `https://x.com/api/login` —— 服务部署在反代子路径下时全部 404，
 * 而报错文案说的是「登录失败（404）」，指向一个用户并没有配错的地方。
 * 给 base 补尾斜杠、把 pathname 的前导斜杠去掉，前缀才会被保留。
 */
function joinUrl(base, pathname) {
  const root = base.endsWith('/') ? base : `${base}/`;
  return new URL(String(pathname).replace(/^\/+/, ''), root).href;
}

function createJournalTracker({ baseUrl, email, password, timeoutMs = DEFAULT_TIMEOUT }) {
  let token = '';
  const normalizedBaseUrl = normalizeHttpUrl(baseUrl);

  function configured() {
    return Boolean(normalizedBaseUrl && email && password);
  }

  async function call(pathname, { method = 'GET', body, auth = true } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(joinUrl(normalizedBaseUrl, pathname), {
        method,
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(auth && token ? { Authorization: `Bearer ${token}` } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async function login() {
    const response = await call('/api/login', { method: 'POST', body: { email, password }, auth: false });
    if (!response.ok) throw new Error(`登录失败（${response.status}）`);
    const data = await response.json();
    token = data.token || data.access_token || '';
    if (!token) throw new Error('登录响应里没有 token');
    return token;
  }

  /**
   * 拉待读论文。
   *
   * token 会过期，所以 401 时自动重登一次再试。只重试一次 ——
   * 再失败就是凭据或服务本身的问题，无限重试只会把日志刷满。
   */
  async function papers({ limit = 20 } = {}) {
    if (!configured()) {
      return { available: false, reason: '未在应用设置中配置 journal-tracker' };
    }
    try {
      if (!token) await login();

      let response = await call(`/api/papers?limit=${limit}`);
      if (response.status === 401) {
        await login();
        response = await call(`/api/papers?limit=${limit}`);
      }
      if (!response.ok) return { available: false, reason: `拉取失败（${response.status}）` };

      const data = await response.json();
      const rows = Array.isArray(data) ? data : (data.papers || data.results || []);
      return { available: true, papers: rows.map(normalizePaper).filter(Boolean).slice(0, limit) };
    } catch (error) {
      return { available: false, reason: `连接 journal-tracker 失败：${error.message}` };
    }
  }

  return { configured, papers, login };
}

function normalizePaper(row) {
  if (!row) return null;
  const title = String(row.title || row.paper_title || '').trim();
  if (!title) return null;
  return {
    id: String(row.id ?? row.doi ?? title),
    title,
    journal: String(row.journal || row.journal_name || '').trim(),
    doi: String(row.doi || '').trim(),
    url: normalizeHttpUrl(row.url || row.link),
    date: String(row.published_at || row.date || '').slice(0, 10),
    score: Number(row.relevance_score ?? row.score ?? NaN),
    summary: String(row.summary || row.analysis || '').trim()
  };
}

module.exports = { createJournalTracker, normalizePaper, normalizeHttpUrl, joinUrl };
