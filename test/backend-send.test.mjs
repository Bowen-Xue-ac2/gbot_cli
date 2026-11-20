import { upstreamUrl } from '../src/upstream.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { SEND_URL, assertAccepted, encodeSendRequest, patchTuiHostSource, sendBackendPrompt } from '../src/backend-send.mjs';
import { loadWindowsSendCredentials } from '../src/windows-session.mjs';

const input = { agentId: 'fake-bot', prompt: 'mock-only message', clientNonce: 'fixed-test-nonce' };
const auth = { accessToken: 'fake-user-token', accountKey: 'fake-account', teamId: '123', clientVersion: '0.79.3' };

test('protobuf request matches the documented wire fields, including UTF-8 and no session_id', () => {
  const body = encodeSendRequest({ agentId: 'a', clientNonce: 'n', prompt: '你' }, 0, 'm');
  assert.equal(body.toString('hex'), '0a016112016e1a03e4bda0200068018201016da20102656ea80101');
});

test('only explicit accepted or duplicate deliveries count as accepted', () => {
  for (const hex of ['2001', '2002', '2003', '080110032002']) {
    assert.doesNotThrow(() => assertAccepted(Buffer.from(hex, 'hex')));
  }
  assert.throws(() => assertAccepted(Buffer.from('2004', 'hex')),
    error => error.code === 'send-refused' && error.delivery === 'rejected');
  // Empty, unknown delivery, truncated varints/bytes/fixed-width fields, invalid field 0.
  for (const hex of ['', '2000', '2005', '2080', '220278', '0900', '00']) {
    assert.throws(() => assertAccepted(Buffer.from(hex, 'hex')),
      error => error.code === 'send-response' && error.delivery === 'unknown');
  }
});

test('send uses the user login, selected team and original nonce on the fixed backend', async () => {
  let calls = 0;
  const ack = await sendBackendPrompt(input, undefined, {
    loadCredentials: () => auth,
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, SEND_URL);
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.authorization, 'Bearer fake-user-token');
      assert.equal(init.headers['content-type'], 'application/proto');
      assert.equal(init.headers['x-cursor-team-id'], '123');
      assert.equal(init.headers['x-cursor-client-version'], '0.79.3');
      assert.equal(init.headers['x-anyrun-network-token'], undefined);
      assert.equal(init.headers.cookie, undefined);
      assert.ok(Buffer.from(init.body).includes(Buffer.from(input.clientNonce)));
      assert.ok(init.signal instanceof AbortSignal);
      return new Response(Buffer.from('080110032002', 'hex'));
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(ack, { accepted: true, clientNonce: input.clientNonce });
});

test('401/403 are rejections; server errors/disconnects remain unknown, with no retries or secret output', async () => {
  for (const status of [401, 403, 400, 502]) {
    let calls = 0;
    await assert.rejects(sendBackendPrompt(input, undefined, {
      loadCredentials: () => auth,
      fetchImpl: async () => {
        calls++;
        return new Response('private-response fake-user-token', { status });
      },
    }), error => error.status === status &&
      error.delivery === (status < 500 ? 'rejected' : 'unknown') &&
      !error.message.includes('fake-user-token') && !error.message.includes('private-response'));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(sendBackendPrompt(input, undefined, {
    loadCredentials: () => auth,
    fetchImpl: async () => { calls++; throw new Error('connection dropped fake-user-token'); },
  }), error => error.delivery === 'unknown' && !error.message.includes('fake-user-token'));
  assert.equal(calls, 1);
});

test('aborted sends and missing desktop sessions never submit a message', async () => {
  let preflights = 0;
  let calls = 0;
  const options = {
    loadCredentials: () => { preflights++; return auth; },
    fetchImpl: async () => { calls++; throw new Error('must not submit'); },
  };
  await assert.rejects(sendBackendPrompt(input, AbortSignal.abort(), options), { name: 'AbortError' });
  await assert.rejects(sendBackendPrompt({ prompt: 'incomplete' }, undefined, options), { delivery: 'rejected' });
  assert.equal(preflights, 0);
  assert.equal(calls, 0);
  assert.throws(() => loadWindowsSendCredentials(), { code: 'send-session' });
  assert.throws(() => patchTuiHostSource('sender changed'), { code: 'send-adapter' });
});

test('actual TUI host sends via backend while list/transcript stay on the gateway (all traffic mocked)', () => {
  const backendModule = new URL('../src/backend-send.mjs', import.meta.url).href;
  const windowsModule = new URL('../src/windows-session.mjs', import.meta.url).href;
  const hostModule = upstreamUrl('dist/client/host.js').href;
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    const urls = [];
    const richText = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'mention', attrs: { id: 'bot-b', label: 'Bea' } },
    ] }] });
    globalThis.fetch = async (url, init) => {
      urls.push(String(url));
      if (String(url) === ${JSON.stringify(SEND_URL)}) {
        assert.equal(init.headers.authorization, 'Bearer fake-user-token');
        assert.equal(init.headers['x-anyrun-network-token'], undefined);
        const bytes = Buffer.from(richText);
        assert.ok(bytes.length < 128);
        assert.ok(Buffer.from(init.body).includes(Buffer.concat([Buffer.from([0x2a, bytes.length]), bytes])),
          'the actual sender emits the selected reference in protobuf field 5');
        return new Response(Buffer.from('2002', 'hex'));
      }
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fake-gateway-token');
      if (String(url).endsWith('/api/listAgents')) return Response.json({ agents: [{ id: 'fake-bot', name: 'Mock Bot' }] });
      if (String(url).endsWith('/api/getAgentTranscriptTail')) return Response.json({ entries: [] });
      if (String(url).endsWith('/api/sendPrompt')) return new Response('A Sand box session is not permitted on this endpoint.', { status: 502 });
      throw new Error('Unmocked request refused');
    };
    const { patchTuiHostSource } = await import(${JSON.stringify(backendModule)});
    const { protectGatewayFetch } = await import(${JSON.stringify(windowsModule)});
    globalThis.fetch = protectGatewayFetch({ gatewayUrl: 'https://box.cursor.sh/path', token: 'fake-gateway-token' });
    const sender = 'data:text/javascript,' + encodeURIComponent(
      'import { sendBackendPrompt as send } from ' + ${JSON.stringify(JSON.stringify(backendModule))} + ';' +
      'export const sendBackendPrompt = (input, signal) => send(input, signal, { loadCredentials: () => (' +
      ${JSON.stringify(JSON.stringify(auth))} + ') });'
    );
    registerHooks({ load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url !== ${JSON.stringify(hostModule)}) return result;
      return { ...result, source: patchTuiHostSource(Buffer.from(result.source).toString('utf8'), sender) };
    }});
    const { HttpHostClient } = await import(${JSON.stringify(hostModule)});
    const client = new HttpHostClient({ gatewayUrl: 'https://box.cursor.sh/path', token: 'fake-gateway-token' });
    assert.equal((await client.listAgents()).length, 1);
    const ack = await client.sendPrompt({ agentId: 'fake-bot', prompt: '@Bea', richText, wait: false });
    assert.equal(ack.accepted, true);
    await client.getTranscript('fake-bot', 10, { hydrate: false });
    assert.deepEqual(urls, [
      'https://box.cursor.sh/path/api/listAgents',
      ${JSON.stringify(SEND_URL)},
      'https://box.cursor.sh/path/api/getAgentTranscriptTail',
    ]);
    console.log('mock TUI integration passed; external requests: 0');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: script, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /mock TUI integration passed; external requests: 0/);
});
