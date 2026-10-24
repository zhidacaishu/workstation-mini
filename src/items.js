const { workflowOf, normalizeStatus, isValidStatus, statusLabel } = require('./workflows');
const { stringifyFrontmatterValue, patchFrontmatterField, readNote, writeNote } = require('./vault/note');
const { enqueueNote } = require('./vault/note-queue');

function parseData(dataJson) {
  try {
    return JSON.parse(dataJson || '{}') || {};
  } catch {
    return {};
  }
}

function readNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * 审稿意见。写在稿件笔记的 frontmatter 里，逐条带状态和回应：
 *
 *   reviews:
 *     - id: R1.1
 *       comment: 识别策略不清楚
 *       status: done
 *       response: 已在 3.2 节补充
 *
 * 大修时漏回一条意见的代价很大，所以要能逐条勾，并且导得出 response letter。
 */
function parseReviewComments(data) {
  const raw = Array.isArray(data.reviews) ? data.reviews : [];
  return raw.map((item, index) => ({
    id: String(item?.id ?? `R${index + 1}`).trim(),
    comment: stringifyFrontmatterValue(item?.comment).trim(),
    response: stringifyFrontmatterValue(item?.response).trim(),
    done: String(item?.status ?? '').trim().toLowerCase() === 'done'
  })).filter(item => item.comment);
}

function createItems({ db, notesDir }) {
  /** 读一个工作流下的全部条目，状态已归一。 */
  function list(workflowKey) {
    const flow = workflowOf(workflowKey);
    if (!flow) return [];

    return db.listItems(flow.section).map(row => {
      const data = parseData(row.dataJson);
      const reviews = parseReviewComments(data);
      const done = readNumber(data.exercises_done);
      const total = readNumber(data.exercises_total);

      return {
        path: row.path,
        title: row.title,
        status: normalizeStatus(workflowKey, data.status),
        statusLabel: statusLabel(workflowKey, normalizeStatus(workflowKey, data.status)),
        data,
        mtimeMs: row.mtimeMs,
        hash: row.hash,
        // 章节进度：做了多少题。没填就是 null，不假装是 0。
        exercises: total ? { done: done ?? 0, total, percent: Math.round(((done ?? 0) / total) * 100) } : null,
        reviews,
        reviewsOpen: reviews.filter(review => !review.done).length
      };
    });
  }

  /** 按状态分组成看板列。空列也保留，才看得出「这一档现在是空的」。 */
  function board(workflowKey) {
    const flow = workflowOf(workflowKey);
    if (!flow) return { workflow: null, columns: [] };

    const items = list(workflowKey);
    const columns = flow.statuses.map(status => ({
      ...status,
      items: items.filter(item => item.status === status.key)
    }));
    return { workflow: flow, columns, total: items.length };
  }

  /**
   * 改一个条目的状态。
   *
   * 只动 frontmatter 的 status 字段，正文原样保留 —— 正文是唯一真相，
   * 程序不该趁机重排别人写的东西。
   */
  async function setStatus(workflowKey, notePath, status, expectedHash = '') {
    if (!isValidStatus(workflowKey, status)) {
      throw new Error(`「${status}」不是 ${workflowOf(workflowKey)?.label || workflowKey} 的合法状态`);
    }
    // 缺 expectedHash 就直接放行，等于把刚加的防覆盖保护变成可选项：看板页面会带上它，
    // 但任何脚本或缓存着旧页面的标签页都能绕过去，静默盖掉别处的编辑。
    // 笔记删除那条路径是缺了就拒绝，这里保持一致。
    if (!expectedHash) {
      const error = new Error('缺少条目版本，请刷新后重试。');
      error.status = 409;
      throw error;
    }
    return enqueueNote(notesDir, notePath, async () => {
      const note = await readNote(notesDir, notePath);
      if (note.hash !== expectedHash) {
        const error = new Error('条目已被其它编辑修改，请刷新后重试。');
        error.status = 409;
        throw error;
      }
      const raw = patchFrontmatterField(note.raw, 'status', status);
      const written = await writeNote(notesDir, notePath, { raw });
      return { path: notePath, status, hash: written.hash };
    });
  }

  /** 导出 response letter 草稿。逐条列出意见与回应，未回应的显式标出来。 */
  function responseLetter(item) {
    if (!item || item.reviews.length === 0) return '';
    const lines = [`# Response to Reviewers — ${item.title}`, ''];
    for (const review of item.reviews) {
      lines.push(`## ${review.id}`, '', `> ${review.comment.replace(/\n/g, '\n> ')}`, '');
      lines.push(review.response || '（尚未回应）', '');
    }
    return lines.join('\n');
  }

  return { list, board, setStatus, responseLetter, parseReviewComments };
}

module.exports = { createItems, parseReviewComments };
