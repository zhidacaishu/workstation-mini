const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { replaceFileSync } = require('../src/vault/atomic');
const GUIDE_STEPS = 8;
function validateGuideState(value) {
  if (!value || !Number.isInteger(value.step) || value.step < 0 || value.step >= GUIDE_STEPS
    || !['active', 'completed', 'skipped'].includes(value.status)) throw new Error('指引进度不合法。');
  return { version: 1, step: value.step, status: value.status };
}
function createGuideStore(userDataPath) {
  const file = path.join(userDataPath, 'workstation-data', 'guide.json');
  return {
    read() {
      try { return validateGuideState(JSON.parse(fs.readFileSync(file, 'utf8'))); }
      catch { return { version: 1, step: 0, status: 'active' }; }
    },
    write(value) {
      const state = validateGuideState(value);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = file + '.tmp-' + crypto.randomUUID();
      try { fs.writeFileSync(temp, JSON.stringify(state) + '\n'); replaceFileSync(temp, file); }
      catch (error) { fs.rmSync(temp, { force: true }); throw error; }
      return state;
    }
  };
}
module.exports = { createGuideStore, validateGuideState };
