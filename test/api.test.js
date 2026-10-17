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
  assert.deepEqual(r.body, []);

  r = await req('POST', '/memos', { title: 'A', id: 'x', createdAt: 'y', extra: 1 });
  assert.equal(r.status, 201);
  const a = r.body;
  assert.notEqual(a.id, 'x');
  assert.equal(a.body, '');
  assert.match(a.createdAt, ISO);
  assert.equal(a.createdAt, a.updatedAt);
  assert.deepEqual(Object.keys(a).sort(), ['body', 'createdAt', 'id', 'title', 'updatedAt']);

  const b = (await req('POST', '/memos', { title: 'B', body: 'bb' })).body;
  r = await req('GET', '/memos');
  assert.deepEqual(r.body.map((m) => m.id), [a.id, b.id]);

  r = await req('GET', `/memos/${a.id}`);
  assert.deepEqual(r.body, a);

  await new Promise((s) => setTimeout(s, 5));
  r = await req('PATCH', `/memos/${b.id}`, { title: 'B2' });
  assert.equal(r.status, 200);
  assert.equal(r.body.title, 'B2');
  assert.equal(r.body.body, 'bb');
  assert.equal(r.body.createdAt, b.createdAt);
  assert.ok(r.body.updatedAt > b.updatedAt);

  r = await req('PUT', `/memos/${b.id}`, { title: 'B3' });
  assert.equal(r.status, 200);
  assert.equal(r.body.body, '');

  r = await req('PATCH', `/memos/${b.id}`, { title: '  ' });
  assert.equal(r.status, 400);
  assert.equal(typeof r.body.error, 'string');
  assert.equal((await req('GET', `/memos/${b.id}`)).body.title, 'B3');

  r = await req('PUT', `/memos/${b.id}`, { body: 'x' });
  assert.equal(r.status, 400);

  r = await req('DELETE', `/memos/${a.id}`);
  assert.equal(r.status, 204);
  assert.equal(r.body, undefined);
  for (const m of ['GET', 'DELETE']) assert.equal((await req(m, `/memos/${a.id}`)).status, 404);
  assert.equal((await req('PATCH', `/memos/${a.id}`, { title: 'z' })).status, 404);
  assert.equal((await req('PUT', `/memos/${a.id}`, { title: 'z' })).status, 404);

  const c = (await req('POST', '/memos', { title: 'C' })).body;
  assert.notEqual(c.id, a.id);
});

test('create validation', async () => {
  const bad = [
    [], 'str', null, 1, {}, { title: 1 }, { title: '' }, { title: ' \t\n' },
    { title: 'a'.repeat(201) }, { title: 'ok', body: 5 }, { title: 'ok', body: null },
    { title: 'ok', body: 'a'.repeat(10001) },
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
