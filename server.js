'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT ?? '', 10) || 3000;
const MAX_BODY_BYTES = 1024 * 1024;
const TITLE_MAX = 200;
const BODY_MAX = 10000;

// In-memory store. Map preserves insertion order == creation order.
const memos = new Map();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function charLength(s) {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function send(res, status, payload) {
  if (payload === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new HttpError(413, 'Request body too large'));
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return reject(new HttpError(400, 'Request body must be a JSON object'));
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        return reject(new HttpError(400, 'Malformed JSON in request body'));
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return reject(new HttpError(400, 'Request body must be a JSON object'));
      }
      resolve(value);
    });
    req.on('error', reject);
  });
}

function validateTitle(title) {
  if (typeof title !== 'string') throw new HttpError(400, '"title" must be a string');
  if (title.trim() === '') throw new HttpError(400, '"title" must not be empty');
  if (charLength(title) > TITLE_MAX) {
    throw new HttpError(400, `"title" must be at most ${TITLE_MAX} characters`);
  }
  return title;
}

function validateBody(body) {
  if (typeof body !== 'string') throw new HttpError(400, '"body" must be a string');
  if (charLength(body) > BODY_MAX) {
    throw new HttpError(400, `"body" must be at most ${BODY_MAX} characters`);
  }
  return body;
}

// Parse and validate editable fields. mode: 'create' | 'put' | 'patch'.
function parseFields(input, mode) {
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  const out = {};
  if (mode !== 'patch' || has('title')) {
    if (!has('title')) throw new HttpError(400, '"title" is required');
    out.title = validateTitle(input.title);
  }
  if (has('body')) {
    out.body = validateBody(input.body);
  } else if (mode !== 'patch') {
    out.body = '';
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function getMemoOr404(id) {
  const memo = memos.get(id);
  if (!memo) throw new HttpError(404, `Memo not found: ${id}`);
  return memo;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const method = req.method;

  if (path === '/memos') {
    if (method === 'GET') return send(res, 200, [...memos.values()]);
    if (method === 'POST') {
      const input = await readJson(req);
      const fields = parseFields(input, 'create');
      const ts = nowIso();
      const memo = {
        id: crypto.randomUUID(),
        title: fields.title,
        body: fields.body,
        createdAt: ts,
        updatedAt: ts,
      };
      memos.set(memo.id, memo);
      return send(res, 201, memo);
    }
    res.setHeader('Allow', 'GET, POST');
    throw new HttpError(405, `Method ${method} not allowed on /memos`);
  }

  const m = /^\/memos\/([^/]+)$/.exec(path);
  if (m) {
    let id;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      throw new HttpError(404, 'Memo not found');
    }
    if (method === 'GET') return send(res, 200, getMemoOr404(id));
    if (method === 'DELETE') {
      getMemoOr404(id);
      memos.delete(id);
      return send(res, 204);
    }
    if (method === 'PATCH' || method === 'PUT') {
      const memo = getMemoOr404(id);
      const input = await readJson(req);
      const fields = parseFields(input, method === 'PUT' ? 'put' : 'patch');
      // Validation passed; apply atomically.
      if (fields.title !== undefined) memo.title = fields.title;
      if (fields.body !== undefined) memo.body = fields.body;
      memo.updatedAt = nowIso();
      return send(res, 200, memo);
    }
    res.setHeader('Allow', 'GET, PATCH, PUT, DELETE');
    throw new HttpError(405, `Method ${method} not allowed on /memos/:id`);
  }

  throw new HttpError(404, `Route not found: ${method} ${url.pathname}`);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof HttpError) {
      if (err.status === 413) res.setHeader('Connection', 'close');
      return send(res, err.status, { error: err.message });
    }
    console.error(err);
    send(res, 500, { error: 'Internal server error' });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Memo API listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { server };
