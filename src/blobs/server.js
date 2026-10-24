const http = require('node:http');

const { createBlobApp } = require('./app');

const DEFAULT_PORT = 4100;

function parsePort(value) {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`WORKSTATION_BLOB_PORT 必须是 0-65535 的整数，收到：${value}`);
  }
  return port;
}

function parseBytes(value) {
  if (value === undefined || value === '') return undefined;
  const bytes = Number(value);
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new Error(`WORKSTATION_BLOB_MAX_BYTES 必须是正整数，收到：${value}`);
  }
  return bytes;
}

function loadBlobConfig(env = process.env) {
  const root = String(env.WORKSTATION_BLOB_ROOT || '').trim();
  const clientToken = String(env.WORKSTATION_BLOB_TOKEN || '').trim();
  const releaseToken = String(env.WORKSTATION_BLOB_RELEASE_TOKEN || '').trim();

  if (!root) throw new Error('拒绝启动：没有配置 WORKSTATION_BLOB_ROOT（存放二进制资源的目录）。');
  if (!clientToken) throw new Error('拒绝启动：没有配置 WORKSTATION_BLOB_TOKEN。');
  if (!releaseToken) throw new Error('拒绝启动：没有配置 WORKSTATION_BLOB_RELEASE_TOKEN。');
  if (clientToken === releaseToken) {
    throw new Error('拒绝启动：WORKSTATION_BLOB_TOKEN 和 WORKSTATION_BLOB_RELEASE_TOKEN 必须不同。');
  }

  return {
    root,
    clientToken,
    releaseToken,
    // 默认只绑回环，要对外暴露得显式改。和旧版的取舍一致：
    // 绑回环不等于没暴露（隧道和反代都是从本机连回环的），但默认值不该替用户做暴露决定。
    host: String(env.WORKSTATION_BLOB_HOST || '127.0.0.1').trim(),
    port: parsePort(env.WORKSTATION_BLOB_PORT),
    maxBytes: parseBytes(env.WORKSTATION_BLOB_MAX_BYTES)
  };
}

async function startBlobServer(config, { logger = console } = {}) {
  const app = createBlobApp(config);
  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, config.host);
  });

  const address = server.address();
  const origin = `http://${config.host}:${address.port}`;
  logger.log?.(`[blobs] 存储服务已启动：${origin}，根目录 ${config.root}`);

  return {
    server,
    origin,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

if (require.main === module) {
  // loadBlobConfig 是同步抛的，写成 startBlobServer(loadBlobConfig()) 的话
  // 它在 Promise 链之外就炸了，用户看到的是一段栈，而不是那句「怎么补」。
  (async () => {
    const { close } = await startBlobServer(loadBlobConfig());
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        close().then(() => process.exit(0));
      });
    }
  })().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { startBlobServer, loadBlobConfig, DEFAULT_PORT };
