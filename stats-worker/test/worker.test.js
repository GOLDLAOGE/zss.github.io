import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  db.prepare("INSERT INTO events(ts,e,vid,src) VALUES(?,?,?,?)").run(Date.now(), 'view', 'legacy', 'old');
  db.exec(readFileSync(new URL('../migrations/0001_behavior.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) { let args = []; return { bind(...values) { args = values; return this; }, async run() { return db.prepare(sql).run(...args); }, async all() { return { results: db.prepare(sql).all(...args) }; }, async first() { return db.prepare(sql).get(...args) || null; } }; },
    async batch(queries) { return Promise.all(queries.map(q => q.all())); }, raw: db
  };
}
const req = (path, options = {}) => new Request('https://example.test' + path, options);
async function call(env, path, options) { return worker.fetch(req(path, options), env); }
async function auth(env) {
  const response = await call(env, '/login', { method: 'POST', body: new URLSearchParams({ password: 'test-secret' }) });
  assert.equal(response.status, 303);
  return response.headers.get('set-cookie').split(';')[0];
}
async function post(env, payload) { return call(env, '/e', { method: 'POST', headers: { Origin: 'https://goldlaoge.github.io' }, body: JSON.stringify(payload) }); }

test('migration preserves legacy records and collection deduplicates new events', async () => {
  const DB = database(), env = { DB, ADMIN_PASSWORD: 'test-secret', ALLOWED_ORIGINS: 'https://goldlaoge.github.io' };
  const event = { e: 'view', vid: 'visitor', page: '/zss.github.io/', sid: 'session-1', event_id: 'event-1', ref: 'example.com', elapsed_ms: 120, scroll_pct: 25 };
  assert.equal((await post(env, event)).status, 204);
  assert.equal((await post(env, event)).status, 204);
  assert.equal((await post(env, { e: 'copy', vid: 'old-client' })).status, 204);
  assert.equal(DB.raw.prepare('SELECT count(*) AS n FROM events').get().n, 3);
  assert.equal((await post(env, { ...event, e: 'unknown' })).status, 400);
  assert.equal((await post(env, { ...event, event_id: 'event-2', scroll_pct: 101 })).status, 400);
  assert.equal((await post(env, { ...event, event_id: 'event-3', ref: 'https://example.com/path' })).status, 400);
});

test('private queries require login and separate current, legacy and other pages', async () => {
  const DB = database(), env = { DB, ADMIN_PASSWORD: 'test-secret' };
  const base = { vid: 'v', sid: 's1', page: '/zss.github.io/' };
  await post(env, { ...base, e: 'view', event_id: '1' });
  await post(env, { ...base, e: 'copy', event_id: '2', target: 'modal', elapsed_ms: 500, scroll_pct: 50 });
  await post(env, { ...base, e: 'view', sid: 's2', page: '/other/', event_id: '3' });
  assert.equal((await call(env, '/api/stats')).status, 401);
  assert.equal((await call(env, '/api/timeline?sid=s1')).status, 401);
  const cookie = await auth(env), headers = { Cookie: cookie };
  const response = await call(env, '/api/stats?days=7', { headers });
  assert.match(response.headers.get('cache-control'), /no-store/);
  const current = await response.json();
  assert.equal(current.total.pv, 1);
  assert.equal(current.total.visits, 1);
  assert.equal(current.total.copies, 1);
  assert.equal(current.visits.length, 1);
  const legacy = await (await call(env, '/api/stats?days=7&page=legacy', { headers })).json();
  assert.equal(legacy.total.pv, 1);
  const all = await (await call(env, '/api/stats?days=7&page=all', { headers })).json();
  assert.equal(all.total.pv, 3);
  const timeline = await (await call(env, '/api/timeline?sid=s1', { headers })).json();
  assert.deepEqual(timeline.events.map(x => x.e), ['view', 'copy']);
  assert.equal(timeline.events[1].target, 'modal');
  assert.equal((await (await call(env, '/api/timeline?sid=s2', { headers })).json()).events.length, 0);
});

test('known copy target is kept and unknown targets do not drop events', async () => {
  const DB = database(), env = { DB, ADMIN_PASSWORD: 'test-secret' };
  for (const [id, target] of [['copy-target', 'copy'], ['other-target', 'unexpected']]) {
    assert.equal((await post(env, { e: 'dialog_close', vid: 'v', page: '/zss.github.io/', sid: 's', event_id: id, target })).status, 204);
  }
  const rows = DB.raw.prepare("SELECT target FROM events WHERE sid = 's' ORDER BY id").all();
  assert.deepEqual(rows.map(r => r.target), ['copy', '']);
});

test('dashboard script parses and exposes historical filter without exposing admin page to anonymous users', async () => {
  const env = { DB: database(), ADMIN_PASSWORD: 'test-secret' };
  const anonymous = await (await call(env, '/')).text();
  assert.match(anonymous, /输入密码/);
  const cookie = await auth(env);
  const response = await call(env, '/', { headers: { Cookie: cookie } });
  assert.match(response.headers.get('cache-control'), /no-store/);
  const page = await response.text();
  assert.match(page, /历史未知页面/);
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const { Script } = await import('node:vm');
  assert.doesNotThrow(() => new Script(script));
});

test('legacy events do not fabricate visits or session conversions', async () => {
  const DB = database(), env = { DB, ADMIN_PASSWORD: 'test-secret' };
  await post(env, { e: 'view', vid: 'legacy' });
  await post(env, { e: 'copy', vid: 'legacy' });
  await post(env, { e: 'view', vid: 'new', sid: 'new-session', page: '/zss.github.io/', event_id: 'new-view' });
  await post(env, { e: 'copy', vid: 'new', sid: 'new-session', page: '/zss.github.io/', event_id: 'new-copy' });
  await post(env, { e: 'copy', vid: 'orphan', sid: 'orphan-session', page: '/zss.github.io/', event_id: 'orphan-copy' });
  const headers = { Cookie: await auth(env) };
  const legacy = await (await call(env, '/api/stats?page=legacy', { headers })).json();
  assert.equal(legacy.total.views, 1);
  assert.equal(legacy.total.pv, 2);
  assert.equal(legacy.total.visits, 0);
  assert.equal(legacy.total.copies, 0);
  const all = await (await call(env, '/api/stats?page=all', { headers })).json();
  assert.equal(all.total.visits, 1);
  assert.equal(all.total.copies, 1);
  assert.equal(all.total.views, 2);
});

test('dashboard labels timeline actions and retains campaign and WeChat ID dimensions', async () => {
  const env = { DB: database(), ADMIN_PASSWORD: 'test-secret' };
  await post(env, { e: 'view', vid: 'v', sid: 's', page: '/zss.github.io/', w: 'wx-1', cmp: 'campaign-1' });
  const headers = { Cookie: await auth(env) };
  const stats = await (await call(env, '/api/stats', { headers })).json();
  assert.equal(stats.dims.cmp[0].k, 'campaign-1');
  assert.equal(stats.dims.w[0].k, 'wx-1');
  const page = await (await call(env, '/', { headers })).text();
  assert.match(page, /广告系列/);
  assert.match(page, /WeChat ID/);
  assert.match(page, /可见停留/);
  assert.match(page, /弹窗展示/);
  assert.match(page, /点击复制关闭/);
});

test('dashboard renders translated timeline and escapes unknown labels', async () => {
  const env = { DB: database(), ADMIN_PASSWORD: 'test-secret' };
  const headers = { Cookie: await auth(env) };
  const page = await (await call(env, '/', { headers })).text();
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const { runInNewContext } = await import('node:vm');
  const elements = {};
  for (const id of ['days','page','updated','visits','views','pv','copies','daily','dim','breakdown','list','timeline','timelineHint','refresh']) {
    elements[id] = { value: id === 'days' ? '7' : id === 'page' ? 'current' : 'src', addEventListener(type, handler) { this[type] = handler; } };
  }
  const payload = { total:{}, generatedAt:Date.now(), daily:[], dims:{}, visits:[{ sid:'s',started:Date.now() }] };
  const fetch = async url => ({ ok:true, json:async () => url.startsWith('/api/timeline') ? {events:[{ts:Date.now(),e:'dialog_show',target:'copy'},{ts:Date.now(),e:'<unknown>',target:'<unknown>'}]} : payload });
  runInNewContext(script, { document:{getElementById:id=>elements[id]}, fetch, Date, Number, String, Object, Math, encodeURIComponent });
  await new Promise(resolve => setImmediate(resolve));
  elements.list.click({ target:{ closest:() => ({ dataset:{index:'0'} }) } });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(elements.timeline.innerHTML, /弹窗展示/);
  assert.match(elements.timeline.innerHTML, /点击复制关闭/);
  assert.match(elements.timeline.innerHTML, /&lt;unknown&gt;/);
  assert.doesNotMatch(elements.timeline.innerHTML, /<unknown>/);
});

test('daily copies require a view on the same UTC+8 day while period copies allow cross-day visits', async () => {
  const DB = database(), env = { DB, ADMIN_PASSWORD: 'test-secret' };
  const now = Date.now(), dayStart = Math.floor((now + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
  const insert = DB.raw.prepare('INSERT INTO events(ts,e,vid,page,sid,event_id) VALUES(?,?,?,?,?,?)');
  insert.run(dayStart - 1000, 'view', 'cross', '/zss.github.io/', 'cross', 'cross-view');
  insert.run(dayStart + 1000, 'copy', 'cross', '/zss.github.io/', 'cross', 'cross-copy');
  insert.run(dayStart + 2000, 'view', 'same', '/zss.github.io/', 'same', 'same-view');
  insert.run(dayStart + 3000, 'copy', 'same', '/zss.github.io/', 'same', 'same-copy');
  const headers = { Cookie: await auth(env) };
  const data = await (await call(env, '/api/stats?days=7', { headers })).json();
  assert.equal(data.total.copies, 2);
  const today = new Date(dayStart + 8 * 3600000).toISOString().slice(0, 10);
  const row = data.daily.find(r => r.day === today);
  assert.equal(row.visits, 1);
  assert.equal(row.copies, 1);
});
