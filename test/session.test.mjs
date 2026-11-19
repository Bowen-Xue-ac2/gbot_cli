import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { decryptSecret, gatewayHeaders, protectGatewayFetch, requestSession, validateGateway } from '../src/windows-session.mjs';

test('Windows v10 AES-GCM decrypts and rejects a tampered credential', () => {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const blob = Buffer.concat([Buffer.from('v10'), nonce,
    cipher.update('fake-active-account-token'), cipher.final(), cipher.getAuthTag()]);
  assert.equal(decryptSecret(blob.toString('base64'), key), 'fake-active-account-token');
  blob[blob.length - 1] ^= 1;
  assert.throws(() => decryptSecret(blob.toString('base64'), key), { code: 'decrypt' });
});

test('only expected HTTPS gateway hosts are accepted; path is retained', () => {
  assert.equal(validateGateway('https://box.cursorvm.com/route/'), 'https://box.cursorvm.com/route');
  const withUserInfo = new URL('https://box.cursor.sh');
  withUserInfo.username = 'test-user';
  withUserInfo.password = 'test-password';
  for (const value of ['http://box.cursorvm.com', 'https://cursor.com.evil.invalid',
    withUserInfo.href, 'https://box.cursor.sh/?secret=x',
    'https://box.cursor.sh/#token', 'https://box.cursor.sh:1340']) {
    assert.throws(() => validateGateway(value), { code: 'gateway-url' });
  }
});

test('authentication preserves selected team, app version and route headers', async () => {
  let calls = 0;
  const session = await requestSession({ accessToken: 'fake-access', teamId: '123' }, '0.57.2', async (url, init) => {
    calls++;
    assert.equal(url, 'https://api2.cursor.sh/aiserver.v1.GrokBotService/EnsureSandBox');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer fake-access');
    assert.equal(init.headers['x-cursor-team-id'], '123');
    assert.equal(init.headers['x-cursor-client-version'], '0.57.2');
    return new Response(JSON.stringify({ gatewayUrl: 'https://box.cursor.sh/path/',
      gatewayToken: 'fake-gateway', gatewayHeaders: { 'X-Anyrun-Network-Token': 'fake-route' } }));
  });
  assert.equal(calls, 1);
  assert.equal(session.gatewayUrl, 'https://box.cursor.sh/path');
  assert.equal(session.headers['x-anyrun-network-token'], 'fake-route');
  assert.equal(session.token, 'fake-gateway');
  assert.deepEqual(gatewayHeaders({ networkToken: 'fallback-route' }), { 'x-anyrun-network-token': 'fallback-route' });
  assert.deepEqual(gatewayHeaders({ gatewayPortToken: 'port-route' }), { 'x-anyrun-port-token': 'port-route' });
  assert.deepEqual(gatewayHeaders({ gateway_port_token: 'port-route', gatewayHeaders: { 'x-route-extra': 'marker' } }),
    { 'x-anyrun-port-token': 'port-route', 'x-route-extra': 'marker' });
  assert.throws(() => gatewayHeaders({ gatewayHeaders: { Authorization: 'fake' } }), { code: 'gateway-headers' });
});

test('HTTP/auth failures expose neither response contents nor tokens and are not retried', async () => {
  let calls = 0;
  await assert.rejects(requestSession({ accessToken: 'fake-secret' }, '0.57.2', async () => {
    calls++;
    return new Response('private-server-response fake-secret', { status: 401 });
  }), error => error.code === 'backend-http' && /HTTP 401/.test(error.message) &&
    !error.message.includes('fake-secret') && !error.message.includes('private-server-response'));
  assert.equal(calls, 1);
  await assert.rejects(requestSession({ accessToken: 'fake-secret' }, '0.57.2', async () => {
    throw new Error('transport error containing fake-secret');
  }), error => error.code === 'backend-network' && !error.message.includes('fake-secret'));
  await assert.rejects(requestSession({ accessToken: 'fake-secret' }, '0.57.2', async () =>
    new Response(JSON.stringify({ gatewayUrl: 'https://evil.invalid', gatewayToken: 'fake-secret' }))),
  { code: 'gateway-url' });
});

test('gateway requests refuse redirects and credential forwarding to another origin', async () => {
  let calls = 0;
  const guarded = protectGatewayFetch({ gatewayUrl: 'https://box.cursor.sh/path' }, async (_input, init) => {
    calls++;
    assert.equal(init.redirect, 'error');
    return new Response('{}');
  });
  await guarded('https://box.cursor.sh/path/api/listAgents', { headers: { authorization: 'Bearer fake' } });
  await assert.rejects(guarded('https://other.cursor.sh/image', {
    headers: { authorization: 'Bearer fake' },
  }), { code: 'credential-origin' });
  await assert.rejects(guarded('http://box.cursor.sh/image', {
    headers: { 'x-anyrun-network-token': 'fake-route' },
  }), { code: 'credential-origin' });
  assert.equal(calls, 1);
});

test('send login is refreshed and account/team switches are refused (mock files and DPAPI)',
  { skip: process.platform !== 'win32' }, () => {
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { createCipheriv, randomBytes } from 'node:crypto';
      import { join } from 'node:path';
      process.env.APPDATA = join(process.cwd(), '__mock_appdata_not_created__');
      const appRoot = join(process.env.APPDATA, 'Grok Bot');
      const key = randomBytes(32);
      const wrapped = Buffer.from('mock-dpapi-wrapped-key');
      const encrypt = text => {
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        return Buffer.concat([Buffer.from('v10'), nonce, cipher.update(text), cipher.final(), cipher.getAuthTag()]).toString('base64');
      };
      const account = {
        'cursor-access-token': encrypt('fake-user-one'),
        'cursor-selected-team-id': encrypt('123'),
      };
      const accounts = { active: 'first', accounts: {
        first: account, second: { 'cursor-access-token': encrypt('fake-user-other') },
      }};
      const realRead = fs.readFileSync;
      fs.readFileSync = (path, ...args) => {
        if (String(path) === join(appRoot, 'sand-secrets.json')) return JSON.stringify({ version: 1, 'cursor-accounts': JSON.stringify(accounts) });
        if (String(path) === join(appRoot, 'Local State')) return JSON.stringify({ os_crypt: {
          encrypted_key: Buffer.concat([Buffer.from('DPAPI'), wrapped]).toString('base64'),
        }});
        if (String(path) === join(appRoot, 'desktop-status.json')) return JSON.stringify({ appVersion: '0.79.3' });
        return realRead(path, ...args);
      };
      let dpapiCalls = 0;
      childProcess.execFileSync = (exe, args, options) => {
        dpapiCalls++;
        assert.ok(exe.endsWith('powershell.exe'));
        assert.ok(args.includes('-NonInteractive'));
        assert.equal(options.windowsHide, true);
        assert.equal(options.input, wrapped.toString('base64'));
        assert.equal(args.join(' ').includes('fake-user'), false);
        return key.toString('base64');
      };
      syncBuiltinESMExports();
      let networkCalls = 0;
      let flipDuringRefresh = false;
      globalThis.fetch = async (url, init) => {
        networkCalls++;
        assert.equal(url, 'https://api2.cursor.sh/aiserver.v1.GrokBotService/EnsureSandBox');
        assert.equal(init.headers.authorization, networkCalls === 1 ? 'Bearer fake-user-one' : 'Bearer fake-user-refreshed');
        assert.equal(init.headers['x-cursor-team-id'], '123');
        if (flipDuringRefresh) accounts.active = 'second';
        return Response.json({ gatewayUrl: 'https://mock.cursor.sh', gatewayToken: 'fake-gateway' });
      };
      const { loadWindowsSession, loadWindowsSendCredentials, refreshWindowsSession } = await import(${JSON.stringify(new URL('../src/windows-session.mjs', import.meta.url).href)});
      await loadWindowsSession();
      account['cursor-access-token'] = encrypt('fake-user-refreshed');
      const current = loadWindowsSendCredentials();
      assert.equal(current.accessToken, 'fake-user-refreshed');
      assert.equal(current.clientVersion, '0.79.3');
      // Refresh must use the original backend transport, not the gateway-only guard.
      globalThis.fetch = async () => { throw new Error('auth must not use the gateway transport'); };
      assert.equal((await refreshWindowsSession()).token, 'fake-gateway');
      flipDuringRefresh = true;
      await assert.rejects(refreshWindowsSession(), { code: 'account-changed' });
      accounts.active = 'first';
      account['cursor-selected-team-id'] = encrypt('456');
      await assert.rejects(refreshWindowsSession(), { code: 'account-changed' });
      assert.throws(() => loadWindowsSendCredentials(), { code: 'account-changed' });
      accounts.active = 'second';
      assert.throws(() => loadWindowsSendCredentials(), { code: 'account-changed' });
      assert.equal(networkCalls, 3);
      assert.ok(dpapiCalls >= 4);
      console.log('mock Windows login guards passed; real credentials read: 0');
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-'], {
      input: script, encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /mock Windows login guards passed; real credentials read: 0/);
  });
