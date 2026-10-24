const { workflowOf, normalizeStatus, isValidStatus, statusLabel } = require('./workflows');
const { patchFrontmatterField, readNote, writeNote } = require('./vault/note');
const { enqueueNote } = require('./vault/note-queue');

function parseData(dataJson) {
  try {
    return JSON.parse(dataJson || '{}') || {};
  } catch {
    return {};
  }
}

function createItems({ db, notesDir }) {
  /** 研究项目仍是普通笔记，只对状态做归一化。 */
  function list(workflowKey) {
    const flow = workflowOf(workflowKey);
    if (!flow) return [];

    return db.listItems(flow.section).map(row => {
      const data = parseData(row.dataJson);
      const status = normalizeStatus(workflowKey, data.status);
      return {
        path: row.path,
        title: row.title,
        status,
        statusLabel: statusLabel(workflowKey, status),
        data,
        mtimeMs: row.mtimeMs,
        hash: row.hash
      };
    });
  }

  /** 空状态列也保留，便于调整项目进度。 */
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

  /** 只修改状态字段，并校验版本以免覆盖外部编辑。 */
  async function setStatus(workflowKey, notePath, status, expectedHash = '') {
    if (!isValidStatus(workflowKey, status)) {
      throw new Error(`「${status}」不是 ${workflowOf(workflowKey)?.label || workflowKey} 的合法状态`);
    }
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

  return { list, board, setStatus };
}

module.exports = { createItems };
