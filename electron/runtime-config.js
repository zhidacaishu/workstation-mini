const crypto = require('node:crypto');

const { loadConfig } = require('../src/config');

function createRuntimeConfig(settings, { isProduction = true, windowChrome = 'native' } = {}) {
  if (!settings.vaultDir) throw new Error('尚未选择资料库目录。');
  return loadConfig({
    ...settings,
    isProduction,
    windowChrome,
    internalToken: crypto.randomBytes(32).toString('hex')
  });
}

module.exports = { createRuntimeConfig };
