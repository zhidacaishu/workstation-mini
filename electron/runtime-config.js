const crypto = require('node:crypto');

const { loadConfig } = require('../src/config');

function createRuntimeConfig(settings, secrets = {}, { isProduction = true } = {}) {
  if (!settings.vaultDir) throw new Error('尚未选择资料库目录。');
  return loadConfig({
    ...settings,
    ...secrets,
    isProduction,
    internalToken: crypto.randomBytes(32).toString('hex')
  });
}

module.exports = { createRuntimeConfig };
