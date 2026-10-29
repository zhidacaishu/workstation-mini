const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { replaceFileSync } = require('../src/vault/atomic');

// 界面导览的步数：第 0 步是欢迎页，后面每一步高亮侧栏里的一处入口。
// 必须和 src/views/partials/tour.ejs 里的 <template data-guide-step> 数量一致。
const GUIDE_STEPS = 7;
const STATUSES = ['active', 'completed', 'skipped'];
const CHECKLIST = ['shown', 'hidden'];
const DEFAULT_STATE = Object.freeze({ version: 2, step: 0, status: 'active', checklist: 'shown' });

function validateGuideState(value) {
  const checklist = value?.checklist ?? DEFAULT_STATE.checklist;
  if (!value || !Number.isInteger(value.step) || value.step < 0 || value.step >= GUIDE_STEPS
    || !STATUSES.includes(value.status) || !CHECKLIST.includes(checklist)) throw new Error('指引进度不合法。');
  return { version: 2, step: value.step, status: value.status, checklist };
}

/**
 * 读出磁盘上的指引状态。
 *
 * v1 记的是旧版八步弹窗的进度。看完或跳过的人不该因为改版再被打断一次；
 * 看到一半的人，旧步骤号和新导览对不上，从欢迎页重新开始。
 */
function migrateGuideState(raw) {
  if (raw?.version === 2) return validateGuideState(raw);
  if (!raw || !STATUSES.includes(raw.status)) throw new Error('指引进度不合法。');
  return { ...DEFAULT_STATE, status: raw.status };
}

function createGuideStore(userDataPath) {
  const file = path.join(userDataPath, 'workstation-data', 'guide.json');
  function read() {
    try { return migrateGuideState(JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch { return { ...DEFAULT_STATE }; }
  }
  return {
    read,
    /** 只改传进来的字段：导览翻页不会动清单开关，隐藏清单也不会动导览进度。 */
    write(patch) {
      const current = read();
      const state = validateGuideState({
        step: patch?.step ?? current.step,
        status: patch?.status ?? current.status,
        checklist: patch?.checklist ?? current.checklist
      });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = file + '.tmp-' + crypto.randomUUID();
      try { fs.writeFileSync(temp, JSON.stringify(state) + '\n'); replaceFileSync(temp, file); }
      catch (error) { fs.rmSync(temp, { force: true }); throw error; }
      return state;
    }
  };
}

module.exports = { createGuideStore, validateGuideState, migrateGuideState, GUIDE_STEPS };
