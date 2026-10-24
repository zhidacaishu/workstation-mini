const crypto = require('node:crypto');
const express = require('express');

const { createBlobStore, BlobError } = require('./store');

const CLIENT_PREFIXES = new Set(['audio', 'attachments']);
const RELEASE_PREFIX = 'releases';

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizedPrefix(value) {
  const raw = String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!raw || raw.includes('//') || raw.split('/').some(part => !part || part === '.' || part === '..')) return '';
  return raw.split('/')[0];
}

function roleAllows(role, method, prefix) {
  if (!prefix) return false;
  if (role === 'release') {
    return prefix === RELEASE_PREFIX && ['GET', 'HEAD', 'PUT'].includes(method);
  }
  if (role !== 'client') return false;
  if (CLIENT_PREFIXES.has(prefix)) return ['GET', 'HEAD', 'PUT', 'DELETE'].includes(method);
  return prefix === RELEASE_PREFIX && ['GET', 'HEAD'].includes(method);
}

function createBlobApp({ root, clientToken, releaseToken, maxBytes, logger = console } = {}) {
  if (!clientToken || !releaseToken) throw new Error('拒绝启动：大文件存储服务必须配置客户端和发布访问令牌。');
  if (clientToken === releaseToken) throw new Error('拒绝启动：客户端令牌和发布令牌必须不同。');

  const store = createBlobStore({ root, maxBytes });
  const app = express();

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY'
    });
    next();
  });

  app.use((req, res, next) => {
    const supplied = req.get('x-workstation-blob-token');
    if (safeEqual(supplied, clientToken)) req.blobRole = 'client';
    else if (safeEqual(supplied, releaseToken)) req.blobRole = 'release';
    else return res.status(403).json({ ok: false, message: 'Forbidden' });
    next();
  });

  function blobPathOf(req) {
    const raw = req.params.blobPath;
    return Array.isArray(raw) ? raw.join('/') : String(raw || '');
  }

  function authorize(req, res, next) {
    const candidate = req.path === '/blobs'
      ? String(req.query.prefix || '')
      : blobPathOf(req);
    if (!roleAllows(req.blobRole, req.method, normalizedPrefix(candidate))) {
      return res.status(403).json({ ok: false, message: 'Forbidden' });
    }
    next();
  }

  app.get('/blobs', authorize, async (req, res, next) => {
    try {
      const integrity = String(req.query.integrity || '');
      if (integrity && integrity !== 'sha256') {
        throw new BlobError(400, `不支持的完整性算法：${integrity}`);
      }
      res.json({
        ok: true,
        conditionalWrites: true,
        blobs: await store.list({ prefix: String(req.query.prefix || ''), integrity })
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/blobs/*blobPath', authorize, async (req, res, next) => {
    try {
      const { absolute } = await store.openRead(blobPathOf(req));
      res.sendFile(absolute, { acceptRanges: true, dotfiles: 'deny' }, error => {
        if (error && !res.headersSent) next(error);
      });
    } catch (error) {
      next(error);
    }
  });

  app.put('/blobs/*blobPath', authorize, async (req, res, next) => {
    try {
      const declared = Number(req.get('content-length'));
      const written = await store.write(blobPathOf(req), req, {
        declaredSize: Number.isFinite(declared) ? declared : undefined,
        expectedSha256: req.get('x-workstation-expected-sha256')
      });
      res.json({ ok: true, ...written });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/blobs/*blobPath', authorize, async (req, res, next) => {
    try {
      res.json({ ok: true, ...(await store.remove(blobPathOf(req), { expectedSha256: req.get('x-workstation-expected-sha256') })) });
    } catch (error) {
      next(error);
    }
  });

  app.use((req, res) => {
    res.status(404).json({ ok: false, message: `没有这个地址：${req.path}` });
  });

  app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = error instanceof BlobError ? error.status : (error.status || 500);
    if (status >= 500) logger.error?.(error);
    res.status(status).json({
      ok: false,
      message: status >= 500 ? '存储服务内部错误。' : error.message
    });
  });

  return app;
}

module.exports = { createBlobApp, roleAllows, normalizedPrefix };
