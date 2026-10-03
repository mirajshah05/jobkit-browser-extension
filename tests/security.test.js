const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const jobUrl = 'https://job-boards.greenhouse.io/example/jobs/123';
const pageSender = { id: 'extension-test', url: jobUrl, tab: { id: 1 } };
const popupSender = { id: 'extension-test', url: 'chrome-extension://extension-test/popup.html' };

function worker() {
  const local = {}, session = {}, calls = [], opened = [];
  const store = data => ({
    get: async keys => Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map(key => [key, data[key]])),
    set: async values => Object.assign(data, values),
    remove: async keys => (typeof keys === 'string' ? [keys] : keys).forEach(key => delete data[key]),
  });
  const context = vm.createContext({
    URL, URLSearchParams, console, Uint8Array, atob, btoa,
    chrome: { storage: { local: store(local), session: store(session) },
      runtime: { id: 'extension-test', getURL: file => `chrome-extension://extension-test/${file}`, onMessage: { addListener: () => {} } },
      tabs: { create: async options => opened.push(options) } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ token: 'synthetic-session' }) };
    },
  });
  context.importScripts = file => vm.runInContext(fs.readFileSync(path.join(root, 'extension', file), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8'), context);
  return { context, local, session, calls, opened };
}

test('remote and malformed resume URLs are rejected before any request', async () => {
  const { context, calls } = worker();
  for (const url of ['https://example.test/resume.pdf', '//example.test/api/resume',
    'http://127.0.0.1:8765@evil.test/api/resume', 'http://localhost:8765/api/resume',
    '/api/ledger/applications/1/resume?redirect=https://example.test', '/api/../private']) {
    await assert.rejects(context.handleMessage({ type: 'FETCH_RESUME', url }, pageSender));
  }
  assert.equal(calls.length, 0);
});

test('credentials use session storage; requests reject redirects and cookies', async () => {
  const { context, calls, local, session } = worker();
  local.jobkitToken = 'synthetic-old-value';
  await context.api('/api/extension/context');
  assert.equal(local.jobkitToken, undefined);
  assert.equal(session.jobkitToken, 'synthetic-session');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, 'http://127.0.0.1:8765');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.cache, 'no-store');
  }
});

test('authentication refreshes once for both 401 and 403', async () => {
  for (const status of [401, 403]) {
    const { context, session } = worker();
    session.jobkitToken = 'synthetic-stale';
    let attempts = 0;
    context.fetch = async (url, options) => {
      if (url.endsWith('/api/auth/bootstrap')) return { ok: true, json: async () => ({ token: 'synthetic-refreshed' }) };
      attempts++;
      const ok = options.headers.Authorization === 'Bearer synthetic-refreshed';
      return { ok, status: ok ? 200 : status, json: async () => ({ ready: true }) };
    };
    assert.equal((await context.api('/api/extension/context')).ready, true);
    assert.equal(attempts, 2);
  }
});

test('foreign senders, mismatched jobs and remote job links are rejected', async () => {
  const { context, calls, opened } = worker();
  await assert.rejects(context.handleMessage({ type: 'FETCH_USER_RESUME' }, { ...pageSender, id: 'another-extension' }));
  await assert.rejects(context.handleMessage({ type: 'GET_CONTEXT', url: `${jobUrl}4` }, pageSender));
  await assert.rejects(context.handleMessage({ type: 'OPEN_APPLY_TAB', url: jobUrl }, pageSender));
  for (const url of ['javascript:alert(1)', 'https://stripe.com.evil.test/careers/123']) {
    await assert.rejects(context.handleMessage({ type: 'OPEN_APPLY_TAB', url }, popupSender));
  }
  assert.equal(calls.length, 0);
  assert.equal(opened.length, 0);
  await context.handleMessage({ type: 'OPEN_APPLY_TAB', url: jobUrl }, popupSender);
  assert.equal(opened[0].url, jobUrl);
});

test('tracking queries and fragments are stripped', () => {
  const { context } = worker();
  assert.equal(context.sanitizedApplicationUrl(`${jobUrl}?gh_jid=123&email=placeholder&ref=tracking#private`), `${jobUrl}?gh_jid=123`);
});

test('own PDF can be stored, replaced and removed without networking', async () => {
  const { context, calls } = worker();
  const bytes = Array.from(Buffer.from('%PDF-1.7\nSynthetic test only\n'));
  const saved = await context.handleMessage({ type: 'SAVE_USER_RESUME', bytes, filename: 'resume.pdf' }, popupSender);
  assert.equal(saved.filename, 'resume.pdf');
  let fetched = await context.handleMessage({ type: 'FETCH_USER_RESUME' }, pageSender);
  assert.deepEqual(Array.from(fetched.resume.bytes), bytes);
  await context.handleMessage({ type: 'SAVE_USER_RESUME', bytes, filename: 'replacement.pdf' }, popupSender);
  fetched = await context.handleMessage({ type: 'FETCH_USER_RESUME' }, pageSender);
  assert.equal(fetched.resume.filename, 'replacement.pdf');
  await context.handleMessage({ type: 'REMOVE_USER_RESUME' }, popupSender);
  assert.equal((await context.handleMessage({ type: 'FETCH_USER_RESUME' }, pageSender)).resume, null);
  assert.equal(calls.length, 0);
});

test('resume saves reject webpages, non-PDFs, invalid bytes and oversized files', async () => {
  const { context, calls, local } = worker();
  const bytes = Array.from(Buffer.from('%PDF-1.7\nTest\n'));
  await assert.rejects(context.handleMessage({ type: 'SAVE_USER_RESUME', bytes }, pageSender));
  for (const bad of [[1, 2, 3], [...bytes, -1], [...bytes, 1.5], new Array(4 * 1024 * 1024 + 1).fill(0)]) {
    await assert.rejects(context.handleMessage({ type: 'SAVE_USER_RESUME', bytes: bad }, popupSender));
  }
  assert.equal(local.jobkitUserResume, undefined);
  assert.equal(calls.length, 0);
});

test('backend PDF downloads enforce signature and size limit', async () => {
  const { context } = worker();
  const good = Buffer.from('%PDF-1.7\nSynthetic test only\n');
  context.getToken = async () => 'synthetic-session';
  let body = good, length = good.length;
  context.fetch = async () => ({ ok: true, status: 200,
    headers: { get: key => key === 'Content-Length' ? String(length) : null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) });
  const result = await context.handleMessage({ type: 'FETCH_RESUME', applicationId: 1 }, pageSender);
  assert.deepEqual(Array.from(result.bytes), Array.from(good));
  body = Buffer.from('not a PDF');
  await assert.rejects(context.handleMessage({ type: 'FETCH_RESUME', applicationId: 1 }, pageSender));
  body = good; length = 11 * 1024 * 1024;
  await assert.rejects(context.handleMessage({ type: 'FETCH_RESUME', applicationId: 1 }, pageSender));
});
