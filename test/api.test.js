'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 3000 + Math.floor(Math.random() * 20000) + 10000;
const BASE = `http://127.0.0.1:${PORT}`;
let child;

before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => d.toString().includes('listening') && resolve());
    child.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
});

after(() => child.kill());

async function req(method, url, body, raw) {
  const opts = { method, headers: {} };
  if (raw !== undefined) opts.body = raw;
  else if (body !== undefined) opts.body = JSON.stringify(body);
  if (opts.body !== undefined) opts.headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, opts);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('full lifecycle', async () => {
  let r = await req('GET', '/memos');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { items: [], nextCursor: null });

  r = await req('POST', '/memos', { title: 'A', id: 'x', createdAt: 'y', version: 7, extra: 1 });
  assert.equal(r.status, 201);
  const a = r.body;
  assert.notEqual(a.id, 'x');
  assert.equal(a.body, '');
  assert.match(a.createdAt, ISO);
  assert.equal(a.createdAt, a.updatedAt);
  assert.deepEqual(a.tags, []);
  assert.equal(a.version, 1);
  assert.deepEqual(Object.keys(a).sort(), ['body', 'createdAt', 'id', 'tags', 'title', 'updatedAt', 'version']);

  const b = (await req('POST', '/memos', { title: 'B', body: 'bb' })).body;
  r = await req('GET', '/memos');
  assert.deepEqual(r.body.items.map((m) => m.id), [a.id, b.id]);
  assert.equal(r.body.nextCursor, null);

  r = await req('GET', `/memos/${a.id}`);
  assert.deepEqual(r.body, a);

  await new Promise((s) => setTimeout(s, 5));
  r = await req('PATCH', `/memos/${b.id}`, { title: 'B2', version: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.body.title, 'B2');
  assert.equal(r.body.body, 'bb');
  assert.equal(r.body.createdAt, b.createdAt);
  assert.ok(r.body.updatedAt > b.updatedAt);
  assert.equal(r.body.version, 2);

  r = await req('PUT', `/memos/${b.id}`, { title: 'B3', version: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.body.body, '');
  assert.equal(r.body.version, 3);

  r = await req('PATCH', `/memos/${b.id}`, { title: '  ', version: 3 });
  assert.equal(r.status, 400);
  assert.equal(typeof r.body.error, 'string');
  assert.equal((await req('GET', `/memos/${b.id}`)).body.title, 'B3');

  r = await req('PUT', `/memos/${b.id}`, { body: 'x', version: 3 });
  assert.equal(r.status, 400);

  r = await req('DELETE', `/memos/${a.id}`);
  assert.equal(r.status, 204);
  assert.equal(r.body, undefined);
  for (const m of ['GET', 'DELETE']) assert.equal((await req(m, `/memos/${a.id}`)).status, 404);
  assert.equal((await req('PATCH', `/memos/${a.id}`, { title: 'z', version: 1 })).status, 404);
  assert.equal((await req('PUT', `/memos/${a.id}`, { title: 'z', version: 1 })).status, 404);

  const c = (await req('POST', '/memos', { title: 'C' })).body;
  assert.notEqual(c.id, a.id);
});

test('create validation', async () => {
  const bad = [
    [], 'str', null, 1, {}, { title: 1 }, { title: '' }, { title: ' \t\n' },
    { title: 'a'.repeat(201) }, { title: 'ok', body: 5 }, { title: 'ok', body: null },
    { title: 'ok', body: 'a'.repeat(10001) },
    { title: 'ok', tags: 'a' }, { title: 'ok', tags: null }, { title: 'ok', tags: [1] },
    { title: 'ok', tags: [null] }, { title: 'ok', tags: [' '] }, { title: 'ok', tags: [''] },
    { title: 'ok', tags: ['a'.repeat(51)] },
    { title: 'ok', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
  ];
  for (const b of bad) {
    const r = await req('POST', '/memos', b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.equal(typeof r.body.error, 'string');
  }
  assert.equal((await req('POST', '/memos', { title: 'a'.repeat(200), body: 'b'.repeat(10000) })).status, 201);
});

test('malformed JSON and unknown routes', async () => {
  let r = await req('POST', '/memos', undefined, '{bad');
  assert.equal(r.status, 400);
  assert.equal(typeof r.body.error, 'string');
  r = await req('POST', '/memos', undefined, '');
  assert.equal(r.status, 400);
  r = await req('GET', '/nope');
  assert.equal(r.status, 404);
  assert.equal(typeof r.body.error, 'string');
  r = await req('GET', '/memos/does-not-exist');
  assert.equal(r.status, 404);
  assert.equal(typeof r.body.error, 'string');
});

const create = async (fields) => {
  const r = await req('POST', '/memos', { title: 'T', ...fields });
  assert.equal(r.status, 201);
  return r.body;
};
const uniq = () => `u${Math.random().toString(36).slice(2)}`;
const list = (qs) => req('GET', `/memos?${qs}`);

test('tag normalization, de-duplication and limits', async () => {
  let m = await create({ tags: ['  Foo ', 'BAR', 'foo', 'bar', 'Baz', '  baz'] });
  assert.deepEqual(m.tags, ['foo', 'bar', 'baz']);
  // 50 code points after trimming (astral chars count as one).
  m = await create({ tags: [`  ${'😀'.repeat(50)}  `] });
  assert.deepEqual(m.tags, ['😀'.repeat(50)]);
  // 25 inputs that collapse to 20 unique tags is fine.
  const twenty = Array.from({ length: 20 }, (_, i) => `t${i}`);
  m = await create({ tags: [...twenty, 'T0', 'T1', ' t2', 't3 ', 'T4'] });
  assert.deepEqual(m.tags, twenty);
  m = await create({ tags: [] });
  assert.deepEqual(m.tags, []);
  // Validation also applies on PATCH and PUT, and leaves the memo untouched.
  for (const method of ['PATCH', 'PUT']) {
    for (const tags of ['x', [1], ['  '], ['a'.repeat(51)], [...twenty, 'extra']]) {
      const r = await req(method, `/memos/${m.id}`, { title: 'T', tags, version: 1 });
      assert.equal(r.status, 400, `${method} ${JSON.stringify(tags)}`);
      assert.equal(typeof r.body.error, 'string');
    }
  }
  const got = (await req('GET', `/memos/${m.id}`)).body;
  assert.equal(got.version, 1);
  assert.deepEqual(got.tags, []);
});

test('PATCH and PUT tag defaults', async () => {
  const m = await create({ body: 'b', tags: ['a', 'b'] });
  let r = await req('PATCH', `/memos/${m.id}`, { title: 'X', version: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tags, ['a', 'b']);
  r = await req('PATCH', `/memos/${m.id}`, { tags: [' C '], version: 2 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tags, ['c']);
  assert.equal(r.body.title, 'X');
  r = await req('PUT', `/memos/${m.id}`, { title: 'Y', version: 3 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tags, []);
  assert.equal(r.body.body, '');
  r = await req('PUT', `/memos/${m.id}`, { title: 'Y', tags: ['Z'], version: 4 });
  assert.deepEqual(r.body.tags, ['z']);
  assert.equal(r.body.version, 5);
});

test('version is required and must be a positive integer', async () => {
  const m = await create({});
  for (const method of ['PATCH', 'PUT']) {
    for (const extra of [{}, { version: 0 }, { version: -1 }, { version: 1.5 }, { version: '1' },
      { version: null }, { version: true }, { version: [1] }]) {
      const r = await req(method, `/memos/${m.id}`, { title: 'N', ...extra });
      assert.equal(r.status, 400, `${method} ${JSON.stringify(extra)}`);
      assert.equal(typeof r.body.error, 'string');
    }
  }
  const got = (await req('GET', `/memos/${m.id}`)).body;
  assert.deepEqual(got, m);
  // DELETE needs no version.
  assert.equal((await req('DELETE', `/memos/${m.id}`)).status, 204);
});

test('stale version gives 409 with current, memo unchanged', async () => {
  const m = await create({ body: 'orig', tags: ['x'] });
  const v2 = (await req('PATCH', `/memos/${m.id}`, { body: 'new', version: 1 })).body;
  assert.equal(v2.version, 2);
  for (const method of ['PATCH', 'PUT']) {
    for (const version of [1, 3, 99]) {
      const r = await req(method, `/memos/${m.id}`, { title: 'Stale', tags: [], version });
      assert.equal(r.status, 409);
      assert.equal(typeof r.body.error, 'string');
      assert.deepEqual(r.body.current, v2);
    }
  }
  assert.deepEqual((await req('GET', `/memos/${m.id}`)).body, v2);
});

test('concurrent PATCHes with the same version: one 200, one 409', async () => {
  for (let i = 0; i < 5; i++) {
    const m = await create({});
    const [r1, r2] = await Promise.all([
      req('PATCH', `/memos/${m.id}`, { title: 'one', version: 1 }),
      req('PATCH', `/memos/${m.id}`, { title: 'two', version: 1 }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const winner = r1.status === 200 ? r1 : r2;
    const loser = r1.status === 200 ? r2 : r1;
    assert.equal(winner.body.version, 2);
    assert.deepEqual(loser.body.current, winner.body);
    assert.deepEqual((await req('GET', `/memos/${m.id}`)).body, winner.body);
  }
});

test('tag filter uses AND semantics', async () => {
  const t1 = uniq();
  const t2 = uniq();
  const a = await create({ tags: [t1] });
  const b = await create({ tags: [t1, t2] });
  const c = await create({ tags: [t2, 'other'] });
  let r = await list(`tag=${t1}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items.map((m) => m.id), [a.id, b.id]);
  r = await list(`tag=${t1}&tag=${t2}`);
  assert.deepEqual(r.body.items.map((m) => m.id), [b.id]);
  r = await list(`tag=${encodeURIComponent(`  ${t2.toUpperCase()} `)}`);
  assert.deepEqual(r.body.items.map((m) => m.id), [b.id, c.id]);
  r = await list(`tag=${t1}&tag=nope-${t1}`);
  assert.deepEqual(r.body, { items: [], nextCursor: null });
  // Exact match, not substring.
  r = await list(`tag=${t1.slice(0, -1)}`);
  assert.deepEqual(r.body.items, []);
  for (const bad of ['tag=', 'tag=%20%20', `tag=${t1}&tag=`]) {
    r = await list(bad);
    assert.equal(r.status, 400, bad);
    assert.equal(typeof r.body.error, 'string');
  }
});

test('q is case-insensitive multi-term body search', async () => {
  const t = uniq();
  const a = await create({ title: 'zebra', body: 'The Quick brown FOX', tags: [t] });
  const b = await create({ body: 'quick silver', tags: [t] });
  const c = await create({ body: 'nothing here', tags: [t] });
  const ids = async (q) => (await list(`tag=${t}&q=${encodeURIComponent(q)}`)).body.items.map((m) => m.id);
  assert.deepEqual(await ids('quick'), [a.id, b.id]);
  assert.deepEqual(await ids('  QUICK   fox '), [a.id]);
  assert.deepEqual(await ids('fox\tquick'), [a.id]);
  assert.deepEqual(await ids('ick bro'), [a.id]);
  assert.deepEqual(await ids('quick missing'), []);
  assert.deepEqual(await ids('zebra'), []); // title is not searched
  assert.deepEqual(await ids('   '), [a.id, b.id, c.id]);
  assert.deepEqual(await ids(''), [a.id, b.id, c.id]);
  // First q wins.
  const r = await list(`tag=${t}&q=silver&q=fox`);
  assert.deepEqual(r.body.items.map((m) => m.id), [b.id]);
});

test('limit and cursor paging walks all items exactly once', async () => {
  const t = uniq();
  const created = [];
  for (let i = 0; i < 7; i++) created.push((await create({ body: `n${i}`, tags: [t] })).id);
  // Interleave non-matching memos to check filters apply before paging.
  await create({ tags: ['x'] });
  for (const limit of [1, 2, 3, 6, 7, 100]) {
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const r = await list(`tag=${t}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(r.status, 200);
      assert.ok(r.body.items.length > 0, 'no empty pages');
      assert.ok(r.body.items.length <= limit);
      seen.push(...r.body.items.map((m) => m.id));
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor !== null);
    assert.deepEqual(seen, created, `limit=${limit}`);
    assert.equal(pages, Math.ceil(created.length / limit));
  }
  // Updates do not change position.
  await req('PATCH', `/memos/${created[0]}`, { title: 'moved?', version: 1 });
  const r = await list(`tag=${t}&limit=2`);
  assert.deepEqual(r.body.items.map((m) => m.id), created.slice(0, 2));
  assert.equal(typeof r.body.nextCursor, 'string');
  // Default limit is 20.
  for (let i = 0; i < 21; i++) await create({ tags: [`${t}-d`] });
  const d = await list(`tag=${t}-d`);
  assert.equal(d.body.items.length, 20);
  assert.notEqual(d.body.nextCursor, null);
  const d2 = await list(`tag=${t}-d&cursor=${d.body.nextCursor}`);
  assert.equal(d2.body.items.length, 1);
  assert.equal(d2.body.nextCursor, null);
});

test('invalid limit or cursor gives 400', async () => {
  for (const qs of ['limit=0', 'limit=101', 'limit=-1', 'limit=1.5', 'limit=abc', 'limit=',
    'limit=%201', 'limit=1e1', 'limit=+5', 'limit=0x10',
    'cursor=', 'cursor=%21%21', `cursor=${Buffer.from('-1').toString('base64url')}`,
    `cursor=${Buffer.from('abc').toString('base64url')}`, `cursor=${Buffer.from('1.5').toString('base64url')}`]) {
    const r = await list(qs);
    assert.equal(r.status, 400, qs);
    assert.equal(typeof r.body.error, 'string');
  }
  for (const qs of ['limit=1', 'limit=100', 'limit=007', `cursor=${Buffer.from('0').toString('base64url')}`, 'unknown=1']) {
    assert.equal((await list(qs)).status, 200, qs);
  }
});

test("deleting the cursor's memo does not break paging", async () => {
  const t = uniq();
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await create({ tags: [t] })).id);
  const p1 = await list(`tag=${t}&limit=2`);
  assert.deepEqual(p1.body.items.map((m) => m.id), ids.slice(0, 2));
  assert.equal((await req('DELETE', `/memos/${ids[1]}`)).status, 204);
  const p2 = await list(`tag=${t}&limit=2&cursor=${p1.body.nextCursor}`);
  assert.equal(p2.status, 200);
  assert.deepEqual(p2.body.items.map((m) => m.id), ids.slice(2, 4));
  // Deleting the last remaining match after the cursor yields null on the next page.
  assert.equal((await req('DELETE', `/memos/${ids[4]}`)).status, 204);
  const p3 = await list(`tag=${t}&limit=2&cursor=${p1.body.nextCursor}`);
  assert.deepEqual(p3.body.items.map((m) => m.id), ids.slice(2, 4));
  assert.equal(p3.body.nextCursor, null);
});
