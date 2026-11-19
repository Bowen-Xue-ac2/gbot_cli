import test from 'node:test';
import assert from 'node:assert/strict';
import { protectGatewayFetch, LauncherError } from '../src/windows-session.mjs';
import { upstreamUrl } from '../src/upstream.mjs';
const { HttpHostClient } = await import(upstreamUrl('dist/client/host.js'));

const initial = () => ({ gatewayUrl: 'https://old.cursorvm.com/route-one', token: 'old-token',
  headers: { 'x-anyrun-network-token': 'old-network', 'x-old-route': 'old-route' } });
const fresh = () => ({ gatewayUrl: 'https://new.cursorvm.com/route-two', token: 'new-token',
  headers: { 'x-new-route': 'new-route' } });
const sleeping = () => new Response('gateway asleep', { status: 417, headers: {
  'x-anyrun-error-source': 'anyrun-proxy', 'x-anyrun-failure-reason': 'pod_hibernated',
} });
const readInit = signal => ({ method: 'POST', headers: {
  authorization: 'Bearer old-token', 'content-type': 'application/json',
  'x-anyrun-network-token': 'old-network', 'x-old-route': 'old-route',
}, body: JSON.stringify({ id: 'fake-bot', limit: 100 }), ...(signal ? { signal } : {}) });
const oldTail = 'https://old.cursorvm.com/route-one/api/getAgentTranscriptTail';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('hibernated read refreshes route/credentials and preserves the read body', async () => {
  const session = initial();
  const requests = [];
  let refreshes = 0;
  const fetcher = protectGatewayFetch(session, async (url, init) => {
    requests.push({ url: String(url), body: init.body });
    if (String(url) === oldTail) return sleeping();
    assert.equal(String(url), 'https://new.cursorvm.com/route-two/api/getAgentTranscriptTail');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), 'Bearer new-token');
    assert.equal(headers.get('x-anyrun-network-token'), null);
    assert.equal(headers.get('x-old-route'), null);
    assert.equal(headers.get('x-new-route'), 'new-route');
    assert.equal(init.redirect, 'error');
    return Response.json({ entries: [{ id: 'new-reply' }] });
  }, { refreshSession: async () => { refreshes++; return fresh(); } });
  assert.equal((await (await fetcher(oldTail, readInit())).json()).entries[0].id, 'new-reply');
  // The real UI retains its old URL/header snapshot after recovery.
  assert.equal((await fetcher(oldTail, readInit())).status, 200);
  assert.equal(refreshes, 1);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => request.body === readInit().body));
  assert.equal(session.gatewayUrl, fresh().gatewayUrl);
  await assert.rejects(fetcher('https://foreign.invalid/api/listAgents', readInit()), { code: 'credential-origin' });
});

test('generic 417s, auth errors and mutations are never automatically replayed', async () => {
  const cases = [
    { method: 'getAgentTranscriptTail', response: () => new Response('not a hibernation signal', { status: 417 }) },
    { method: 'getAgentTranscriptTail', response: () => new Response('', { status: 417, headers: {
      'x-anyrun-error-source': 'anyrun-proxy', 'x-anyrun-failure-reason': 'other',
    } }) },
    { method: 'getAgentTranscriptTail', response: () => new Response('', { status: 401 }) },
    { method: 'sendPrompt', response: sleeping },
    { method: 'interruptAgentRun', response: sleeping },
  ];
  for (const item of cases) {
    let requests = 0;
    let refreshes = 0;
    const fetcher = protectGatewayFetch(initial(), async () => { requests++; return item.response(); }, {
      refreshSession: async () => { refreshes++; return fresh(); },
    });
    assert.equal((await fetcher('https://old.cursorvm.com/route-one/api/' + item.method, readInit())).ok, false);
    assert.equal(requests, 1);
    assert.equal(refreshes, 0);
  }
});

test('persistent hibernation retries once, then rate-limits further wakeups', async () => {
  let time = 0;
  let requests = 0;
  let refreshes = 0;
  const fetcher = protectGatewayFetch(initial(), async () => { requests++; return sleeping(); }, {
    now: () => time, refreshSession: async () => { refreshes++; return fresh(); },
  });
  assert.equal((await fetcher(oldTail, readInit())).status, 417);
  assert.equal(requests, 2);
  assert.equal(refreshes, 1);
  assert.equal((await fetcher(oldTail, readInit())).status, 417);
  assert.equal(requests, 3);
  assert.equal(refreshes, 1);
  time = 5000;
  assert.equal((await fetcher(oldTail, readInit())).status, 417);
  assert.equal(requests, 5);
  assert.equal(refreshes, 2);
});

test('concurrent roster and transcript polls share one refresh', async () => {
  let refreshes = 0;
  let finish;
  const fetcher = protectGatewayFetch(initial(), async url =>
    String(url).startsWith('https://old.') ? sleeping() : Response.json({ ok: true }), {
    refreshSession: () => { refreshes++; return new Promise(resolve => { finish = resolve; }); },
  });
  const transcript = fetcher(oldTail, readInit());
  const roster = fetcher('https://old.cursorvm.com/route-one/api/listAgents', readInit());
  await tick();
  assert.equal(refreshes, 1);
  finish(fresh());
  assert.deepEqual((await Promise.all([transcript, roster])).map(response => response.status), [200, 200]);
});

test('a late old-route 417 reuses the already refreshed route', async () => {
  let oldRequests = 0;
  let refreshes = 0;
  let releaseOld;
  let time = 0;
  const fetcher = protectGatewayFetch(initial(), async url => {
    if (!String(url).startsWith('https://old.')) return Response.json({ ok: true });
    if (++oldRequests === 1) return sleeping();
    return new Promise(resolve => { releaseOld = () => resolve(sleeping()); });
  }, { now: () => time, refreshSession: async () => { refreshes++; return fresh(); } });
  const first = fetcher(oldTail, readInit());
  const late = fetcher(oldTail, readInit());
  assert.equal((await first).status, 200);
  time = 10000;
  releaseOld();
  assert.equal((await late).status, 200);
  assert.equal(refreshes, 1);
});

test('cancelling a reader preserves shared recovery for other readers', async () => {
  const controller = new AbortController();
  let finish;
  let refreshes = 0;
  const fetcher = protectGatewayFetch(initial(), async url =>
    String(url).startsWith('https://old.') ? sleeping() : Response.json({ ok: true }), {
    refreshSession: () => { refreshes++; return new Promise(resolve => { finish = resolve; }); },
  });
  const cancelled = fetcher(oldTail, readInit(controller.signal));
  const rejected = assert.rejects(cancelled, { name: 'AbortError' });
  const other = fetcher(oldTail, readInit());
  await tick();
  controller.abort();
  await rejected;
  finish(fresh());
  assert.equal((await other).status, 200);
  assert.equal(refreshes, 1);
});

test('failed refresh preserves the old session and does not immediately repeat auth', async () => {
  const session = initial();
  let refreshes = 0;
  const fetcher = protectGatewayFetch(session, async () => sleeping(), {
    now: () => 0, refreshSession: async () => {
      refreshes++;
      throw new LauncherError('account-changed', 'Account changed; restart required.');
    },
  });
  await assert.rejects(fetcher(oldTail, readInit()), { code: 'account-changed' });
  assert.deepEqual(session, initial());
  assert.equal((await fetcher(oldTail, readInit())).status, 417);
  assert.equal(refreshes, 1);
});

test('Request bodies and clients created after recovery both use the refreshed route', async () => {
  let oldRequests = 0;
  const fetcher = protectGatewayFetch(initial(), async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://old.')) { oldRequests++; return sleeping(); }
    assert.equal(await input.text(), readInit().body);
    return Response.json({ entries: [] });
  }, { refreshSession: async () => fresh() });
  const request = new Request(oldTail, readInit());
  assert.equal((await fetcher(request)).status, 200);
  assert.equal((await fetcher(new Request('https://new.cursorvm.com/route-two/api/getAgentTranscriptTail', readInit()))).status, 200);
  assert.equal(oldRequests, 1);
});

test('actual TUI receive recovers from 417 without sending any message', async () => {
  let refreshes = 0;
  let writes = 0;
  const fetcher = protectGatewayFetch(initial(), async (url, init) => {
    if (String(url).includes('/api/sendPrompt') || String(url).includes('/api/interrupt')) writes++;
    if (String(url).startsWith('https://old.')) return sleeping();
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer new-token');
    return Response.json({ entries: [{ id: 'reply', kind: 'send-message', message: { type: 'text', content: 'mock reply' }, timestampMs: 1 }] });
  }, { refreshSession: async () => { refreshes++; return fresh(); } });
  const client = new HttpHostClient({ gatewayUrl: initial().gatewayUrl, token: initial().token,
    headers: initial().headers, fetch: fetcher });
  assert.equal((await client.getTranscript('fake-bot', 10, { hydrate: false }))[0].text, 'mock reply');
  assert.equal(refreshes, 1);
  assert.equal(writes, 0);
});
