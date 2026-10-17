'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT ?? '', 10) || 3000;
const MAX_BODY_BYTES = 1024 * 1024;
const TITLE_MAX = 200;
const BODY_MAX = 10000;
const TAG_MAX = 50;
const TAGS_MAX = 20;
const LIMIT_DEFAULT = 20;
const LIMIT_MIN = 1;
const LIMIT_MAX = 100;

// In-memory store. Map preserves insertion order == creation order.
const memos = new Map();
// Internal creation sequence numbers (never reused, not exposed).
const seqs = new Map();
let lastSeq = 0;
// Per-memo change history: id -> array of entries, ascending by version.
const histories = new Map();

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

function normalizeTag(t) {
  return t.trim().toLowerCase();
}

function validateTags(tags) {
  if (!Array.isArray(tags)) throw new HttpError(400, '"tags" must be an array');
  const out = [];
  const seen = new Set();
  for (const t of tags) {
    if (typeof t !== 'string') throw new HttpError(400, '"tags" elements must be strings');
    const n = normalizeTag(t);
    if (n === '') throw new HttpError(400, '"tags" elements must not be empty');
    if (charLength(n) > TAG_MAX) {
      throw new HttpError(400, `"tags" elements must be at most ${TAG_MAX} characters`);
    }
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  if (out.length > TAGS_MAX) throw new HttpError(400, `"tags" must have at most ${TAGS_MAX} items`);
  return out;
}

function validateVersion(input) {
  if (!Object.prototype.hasOwnProperty.call(input, 'version')) {
    throw new HttpError(400, '"version" is required');
  }
  const v = input.version;
  if (!Number.isInteger(v) || v < 1) throw new HttpError(400, '"version" must be a positive integer');
  return v;
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
  if (has('tags')) {
    out.tags = validateTags(input.tags);
  } else if (mode !== 'patch') {
    out.tags = [];
  }
  if (mode !== 'create') out.version = validateVersion(input);
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

function parseListQuery(params) {
  const tags = params.getAll('tag').map((t) => {
    const n = normalizeTag(t);
    if (n === '') throw new HttpError(400, '"tag" must not be empty');
    return n;
  });
  const q = params.get('q');
  const terms = q === null ? [] : q.toLowerCase().split(/\s+/).filter((t) => t !== '');

  const limit = parseLimit(params);

  let after = 0;
  const cursor = params.get('cursor');
  if (cursor !== null) {
    const decoded = /^[A-Za-z0-9_-]+$/.test(cursor)
      ? Buffer.from(cursor, 'base64url').toString('utf8')
      : '';
    if (!/^[0-9]+$/.test(decoded) || !Number.isSafeInteger(Number(decoded))) {
      throw new HttpError(400, 'Invalid "cursor"');
    }
    after = Number(decoded);
  }
  return { tags, terms, limit, after };
}

function parseLimit(params) {
  let limit = LIMIT_DEFAULT;
  const rawLimit = params.get('limit');
  if (rawLimit !== null) {
    if (!/^[0-9]+$/.test(rawLimit)) throw new HttpError(400, '"limit" must be an integer');
    limit = Number(rawLimit);
    if (limit < LIMIT_MIN || limit > LIMIT_MAX) {
      throw new HttpError(400, `"limit" must be between ${LIMIT_MIN} and ${LIMIT_MAX}`);
    }
  }
  return limit;
}

function recordHistory(memo, action, revertedFrom = null) {
  let list = histories.get(memo.id);
  if (!list) {
    list = [];
    histories.set(memo.id, list);
  }
  list.push({
    version: memo.version,
    title: memo.title,
    body: memo.body,
    tags: [...memo.tags],
    updatedAt: memo.updatedAt,
    action,
    revertedFrom,
  });
}

// History cursor: base64url of "h:<memo id>:<last version on the page>".
// Bound to the memo so a cursor from another memo or from GET /memos is rejected.
function encodeHistoryCursor(id, version) {
  return Buffer.from(`h:${id}:${version}`, 'utf8').toString('base64url');
}

function listHistory(id, params) {
  getMemoOr404(id);
  const limit = parseLimit(params);
  let after = 0;
  const cursor = params.get('cursor');
  if (cursor !== null) {
    const decoded = /^[A-Za-z0-9_-]+$/.test(cursor)
      ? Buffer.from(cursor, 'base64url').toString('utf8')
      : '';
    const prefix = `h:${id}:`;
    const rest = decoded.startsWith(prefix) ? decoded.slice(prefix.length) : '';
    if (!/^[0-9]+$/.test(rest) || !Number.isSafeInteger(Number(rest))) {
      throw new HttpError(400, 'Invalid "cursor"');
    }
    after = Number(rest);
  }
  const all = histories.get(id) ?? [];
  // Entries are in ascending version order (oldest first).
  const start = all.findIndex((e) => e.version > after);
  const from = start === -1 ? all.length : start;
  const items = all.slice(from, from + limit);
  const hasMore = from + limit < all.length;
  return {
    items,
    nextCursor: hasMore ? encodeHistoryCursor(id, items[items.length - 1].version) : null,
  };
}

function parseRevert(input) {
  if (!Object.prototype.hasOwnProperty.call(input, 'toVersion')) {
    throw new HttpError(400, '"toVersion" is required');
  }
  const toVersion = input.toVersion;
  if (!Number.isInteger(toVersion) || toVersion < 1) {
    throw new HttpError(400, '"toVersion" must be a positive integer');
  }
  return { toVersion, version: validateVersion(input) };
}

function encodeCursor(seq) {
  return Buffer.from(String(seq), 'utf8').toString('base64url');
}

function listMemos(params) {
  const { tags, terms, limit, after } = parseListQuery(params);
  const matches = (memo) => {
    if (!tags.every((t) => memo.tags.includes(t))) return false;
    if (terms.length === 0) return true;
    const body = memo.body.toLowerCase();
    return terms.every((t) => body.includes(t));
  };
  const items = [];
  let lastItemSeq = 0;
  let hasMore = false;
  // Map iteration order == creation order == ascending sequence number.
  for (const memo of memos.values()) {
    const seq = seqs.get(memo.id);
    if (seq <= after || !matches(memo)) continue;
    if (items.length === limit) {
      hasMore = true;
      break;
    }
    items.push(memo);
    lastItemSeq = seq;
  }
  return { items, nextCursor: hasMore ? encodeCursor(lastItemSeq) : null };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const method = req.method;

  if (path === '/memos') {
    if (method === 'GET') return send(res, 200, listMemos(url.searchParams));
    if (method === 'POST') {
      const input = await readJson(req);
      const fields = parseFields(input, 'create');
      const ts = nowIso();
      const memo = {
        id: crypto.randomUUID(),
        title: fields.title,
        body: fields.body,
        tags: fields.tags,
        version: 1,
        createdAt: ts,
        updatedAt: ts,
      };
      memos.set(memo.id, memo);
      seqs.set(memo.id, ++lastSeq);
      recordHistory(memo, 'create');
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
      seqs.delete(id);
      histories.delete(id);
      return send(res, 204);
    }
    if (method === 'PATCH' || method === 'PUT') {
      getMemoOr404(id);
      const input = await readJson(req);
      const fields = parseFields(input, method === 'PUT' ? 'put' : 'patch');
      // Validation passed. Everything below is synchronous, so the
      // compare-and-set on version is atomic within the event loop.
      const memo = getMemoOr404(id);
      if (fields.version !== memo.version) {
        return send(res, 409, {
          error: `Version conflict: expected ${memo.version}, got ${fields.version}`,
          current: memo,
        });
      }
      if (fields.title !== undefined) memo.title = fields.title;
      if (fields.body !== undefined) memo.body = fields.body;
      if (fields.tags !== undefined) memo.tags = fields.tags;
      memo.version += 1;
      memo.updatedAt = nowIso();
      recordHistory(memo, 'update');
      return send(res, 200, memo);
    }
    res.setHeader('Allow', 'GET, PATCH, PUT, DELETE');
    throw new HttpError(405, `Method ${method} not allowed on /memos/:id`);
  }

  const sub = /^\/memos\/([^/]+)\/(history|revert)$/.exec(path);
  if (sub) {
    let id;
    try {
      id = decodeURIComponent(sub[1]);
    } catch {
      throw new HttpError(404, 'Memo not found');
    }
    if (sub[2] === 'history') {
      if (method === 'GET') return send(res, 200, listHistory(id, url.searchParams));
      res.setHeader('Allow', 'GET');
      throw new HttpError(405, `Method ${method} not allowed on /memos/:id/history`);
    }
    if (method === 'POST') {
      getMemoOr404(id);
      const input = await readJson(req);
      const { toVersion, version } = parseRevert(input);
      // Synchronous from here on: the version compare-and-set is atomic, exactly
      // like PATCH/PUT, so of two concurrent writers with the same version one
      // wins and the other gets 409.
      const memo = getMemoOr404(id);
      if (version !== memo.version) {
        return send(res, 409, {
          error: `Version conflict: expected ${memo.version}, got ${version}`,
          current: memo,
        });
      }
      if (toVersion === memo.version) {
        throw new HttpError(400, `"toVersion" ${toVersion} is already the current version`);
      }
      const target = (histories.get(id) ?? []).find((e) => e.version === toVersion);
      if (!target) {
        throw new HttpError(404, `Version ${toVersion} not found in history of memo ${id}`);
      }
      memo.title = target.title;
      memo.body = target.body;
      memo.tags = [...target.tags];
      memo.version += 1;
      memo.updatedAt = nowIso();
      recordHistory(memo, 'revert', toVersion);
      return send(res, 200, memo);
    }
    res.setHeader('Allow', 'POST');
    throw new HttpError(405, `Method ${method} not allowed on /memos/:id/revert`);
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
