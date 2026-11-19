// Windows credential decoding follows grok-bot-cli 0.12.5 (MIT; see licenses/grok-bot-cli-MIT.txt).
import { execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const appRoot = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Grok Bot');
const backend = 'https://api2.cursor.sh/aiserver.v1.GrokBotService/EnsureSandBox';
// Keep auth refresh independent of the per-gateway fetch guard installed at startup.
const sessionFetch = globalThis.fetch;
let pendingSession;
let owner;
let ownerTeam;

export class LauncherError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function readJson(name) {
  try {
    return JSON.parse(readFileSync(join(appRoot, name), 'utf8'));
  } catch {
    throw new LauncherError('local-state', `Cannot read Grok Bot ${name}. Open the desktop app and sign in.`);
  }
}

function selectedAccount() {
  const stored = readJson('sand-secrets.json');
  if (stored.version != null && stored.version !== 1) {
    throw new LauncherError('storage-version', 'Unsupported Grok Bot credential storage version.');
  }
  let accounts;
  try {
    accounts = JSON.parse(stored['cursor-accounts'] ?? 'null');
  } catch {
    throw new LauncherError('account', 'Cannot read the active Grok Bot account. Sign in again in the desktop app.');
  }
  if (typeof accounts?.active !== 'string' || !Object.hasOwn(accounts.accounts ?? {}, accounts.active)) {
    throw new LauncherError('signed-out', 'No active Grok Bot account. Sign in in the desktop app first.');
  }
  return { key: accounts.active, account: accounts.accounts[accounts.active] };
}

function unprotectKey() {
  const blob = Buffer.from(readJson('Local State').os_crypt?.encrypted_key || '', 'base64');
  if (blob.subarray(0, 5).toString('latin1') !== 'DPAPI') {
    throw new LauncherError('safe-storage', 'Grok Bot has no Windows Safe Storage key.');
  }
  // Only the encrypted blob goes through stdin; no secret is placed in arguments.
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
    "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); " +
    "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";
  try {
    const result = execFileSync(join(process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: blob.subarray(5).toString('base64'), encoding: 'utf8',
      windowsHide: true, timeout: 15000, maxBuffer: 65536,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const key = Buffer.from(result.trim(), 'base64');
    if (key.length !== 32) throw new Error('key length');
    return key;
  } catch {
    throw new LauncherError('dpapi', 'Windows could not decrypt the Grok Bot key for the current user.');
  }
}

export function decryptSecret(encoded, key) {
  try {
    const blob = Buffer.from(encoded, 'base64');
    if (blob.length < 31 || blob.subarray(0, 3).toString('latin1') !== 'v10') throw new Error('format');
    const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(3, 15));
    decipher.setAuthTag(blob.subarray(-16));
    return Buffer.concat([decipher.update(blob.subarray(15, -16)), decipher.final()]).toString('utf8');
  } catch {
    throw new LauncherError('decrypt', 'Cannot decrypt a Grok Bot credential. Sign in again in the desktop app.');
  }
}

function credentials() {
  const selected = selectedAccount();
  const encrypted = selected.account?.['cursor-access-token'];
  if (typeof encrypted !== 'string' || !encrypted) {
    throw new LauncherError('access-token', 'The active Grok Bot account has no saved access token.');
  }
  const key = unprotectKey();
  try {
    const accessToken = decryptSecret(encrypted, key).trim();
    if (!accessToken) throw new LauncherError('access-token', 'The active Grok Bot access token is empty.');
    const encryptedTeam = selected.account['cursor-selected-team-id'];
    const teamId = encryptedTeam == null ? undefined : decryptSecret(encryptedTeam, key);
    if (teamId !== undefined && (!/^[1-9][0-9]*$/.test(teamId) || !Number.isSafeInteger(Number(teamId)))) {
      throw new LauncherError('team', 'The selected Grok Bot team is invalid. Select the team in the desktop app.');
    }
    return { accessToken, teamId, accountKey: selected.key };
  } finally {
    key.fill(0);
  }
}

function clientVersion() {
  const version = readJson('desktop-status.json').appVersion;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) {
    throw new LauncherError('app-version', 'Cannot determine the installed Grok Bot app version. Open the desktop app first.');
  }
  return version;
}

export function loadWindowsSendCredentials() {
  if (!pendingSession || !owner) {
    throw new LauncherError('send-session', 'Open a Grok Bot gateway session before sending.');
  }
  // Reread the desktop login for each user-initiated send; never use a stale env token.
  const auth = credentials();
  if (auth.accountKey !== owner || auth.teamId !== ownerTeam) {
    throw new LauncherError('account-changed', 'Grok Bot account or selected team changed. Restart this launcher before sending.');
  }
  return { ...auth, clientVersion: clientVersion() };
}

export function validateGateway(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new LauncherError('gateway-url', 'The service returned an invalid gateway URL.'); }
  const allowed = ['cursor.sh', 'cursor.com', 'cursorvm.com'].some(domain =>
    url.hostname === domain || url.hostname.endsWith('.' + domain));
  if (!allowed || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      (url.port && url.port !== '443')) {
    throw new LauncherError('gateway-url', 'Refused a gateway outside the expected HTTPS Cursor hosts.');
  }
  return url.href.replace(/\/$/, '');
}

export function gatewayHeaders(body) {
  const supplied = body.gatewayHeaders ?? body.gateway_headers;
  const headers = new Headers();
  if (supplied && typeof supplied === 'object' && !Array.isArray(supplied)) {
    for (const [name, value] of Object.entries(supplied)) {
      if (typeof value === 'string' && value) {
        if (/^(host|content-length|connection|authorization|content-type)$/i.test(name)) {
          throw new LauncherError('gateway-headers', 'The service returned an unexpected routing header.');
        }
        try { headers.set(name, value); } catch {
          throw new LauncherError('gateway-headers', 'The service returned an invalid routing header.');
        }
      }
    }
  }
  if (!headers.has('x-anyrun-port-token') && !headers.has('x-anyrun-network-token')) {
    const port = body.gatewayPortToken ?? body.gateway_port_token;
    const network = body.anyrunNetworkToken ?? body.anyrun_network_token ?? body.networkToken;
    const name = typeof port === 'string' && port ? 'x-anyrun-port-token' : 'x-anyrun-network-token';
    const token = name === 'x-anyrun-port-token' ? port : network;
    if (typeof token === 'string' && token) {
      try { headers.set(name, token); } catch {
        throw new LauncherError('gateway-headers', 'The service returned an invalid routing header.');
      }
    }
  }
  return Object.fromEntries(headers);
}

export async function requestSession(auth, clientVersion, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(backend, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000), body: '{}',
      headers: {
        'content-type': 'application/json', 'connect-protocol-version': '1',
        authorization: `Bearer ${auth.accessToken}`, 'x-cursor-client-type': 'sand',
        'x-cursor-client-version': clientVersion, 'x-sand-box-namespace': 'prod',
        ...(auth.teamId === undefined ? {} : { 'x-cursor-team-id': auth.teamId }),
      },
    });
  } catch {
    throw new LauncherError('backend-network', 'Could not reach the Grok Bot authentication service (30s timeout).');
  }
  if (!response.ok) {
    throw new LauncherError('backend-http', `Grok Bot authentication returned HTTP ${response.status}. Check the desktop login and subscription.`);
  }
  let body;
  try { body = await response.json(); } catch {
    throw new LauncherError('backend-response', 'The authentication service returned an invalid response.');
  }
  const rawUrl = body?.gatewayUrl ?? body?.gateway_url;
  const token = body?.gatewayToken ?? body?.gateway_token;
  if (typeof rawUrl !== 'string' || typeof token !== 'string' || !token) {
    throw new LauncherError('backend-response', 'The authentication service returned no gateway session.');
  }
  return { gatewayUrl: validateGateway(rawUrl), token, headers: gatewayHeaders(body) };
}

export async function loadWindowsSession() {
  if (process.platform !== 'win32') throw new LauncherError('platform', 'This launcher requires native Windows.');
  if (pendingSession) {
    if (selectedAccount().key !== owner) throw new LauncherError('account-changed', 'Grok Bot account changed. Restart this launcher.');
    return pendingSession;
  }
  const auth = credentials();
  owner = auth.accountKey;
  ownerTeam = auth.teamId;
  pendingSession = requestSession(auth, clientVersion());
  try {
    const session = await pendingSession;
    if (selectedAccount().key !== owner) throw new LauncherError('account-changed', 'Grok Bot account changed during authentication. Restart this launcher.');
    return session;
  } catch (error) {
    pendingSession = undefined;
    throw error;
  }
}

export async function refreshWindowsSession() {
  const auth = loadWindowsSendCredentials();
  const fresh = await requestSession(auth, auth.clientVersion, sessionFetch);
  // The account/team may have changed while EnsureSandBox was in flight.
  loadWindowsSendCredentials();
  return fresh;
}

function waitForRefresh(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

export function protectGatewayFetch(session, fetchImpl = globalThis.fetch, options = {}) {
  const refresh = options.refreshSession ?? refreshWindowsSession;
  const now = options.now ?? Date.now;
  const reads = new Set(['listAgents', 'getAgentTranscriptTail', 'getAgentThread',
    'getAgentWorkflows', 'readAttachmentImage']);
  // HttpHostClient keeps a copy of its initial URL/headers. Remember known routes
  // so stale client snapshots can still be mapped to the current authenticated route.
  const bases = new Map();
  const routeHeaderNames = new Set(['x-anyrun-network-token', 'x-anyrun-port-token']);
  function rememberRoute() {
    bases.set(session.gatewayUrl, new URL(session.gatewayUrl));
    for (const name of Object.keys(session.headers ?? {})) routeHeaderNames.add(name.toLowerCase());
  }
  rememberRoute();
  let generation = 0;
  let pendingRefresh;
  let refreshAfter = 0;

  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const originalHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const hasCredentials = originalHeaders.has('authorization') || originalHeaders.has('cookie') ||
      [...routeHeaderNames].some(name => originalHeaders.has(name));
    const knownOrigin = [...bases.values()].some(base => base.origin === url.origin);
    if (hasCredentials && !knownOrigin) {
      throw new LauncherError('credential-origin', 'Refused to send gateway credentials to another origin.');
    }
    let method;
    for (const base of bases.values()) {
      const prefix = base.pathname.replace(/\/$/, '') + '/api/';
      if (url.origin === base.origin && url.pathname.startsWith(prefix) && !url.search && !url.hash) {
        const candidate = url.pathname.slice(prefix.length);
        if (candidate && !candidate.includes('/')) method = candidate;
      }
    }
    const verb = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    // Only authenticated TUI gateway POSTs participate in route rewriting/recovery.
    if (!method || verb !== 'POST' || !originalHeaders.has('authorization')) {
      return fetchImpl(input, { ...init, redirect: 'error' });
    }
    if (typeof session.token !== 'string' || !session.token) {
      throw new LauncherError('gateway-session', 'The gateway session has no token. Restart this launcher.');
    }
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    async function attempt() {
      signal?.throwIfAborted();
      const headers = new Headers(originalHeaders);
      for (const name of routeHeaderNames) headers.delete(name);
      headers.set('authorization', 'Bearer ' + session.token);
      for (const [name, value] of Object.entries(session.headers ?? {})) headers.set(name, value);
      const target = session.gatewayUrl.replace(/\/$/, '') + '/api/' + method;
      // Keep the original Request unconsumed so a read can be replayed once.
      const request = input instanceof Request ? new Request(target, input.clone()) : target;
      return fetchImpl(request, { ...init, headers, redirect: 'error' });
    }
    const startedGeneration = generation;
    const response = await attempt();
    const replayable = init?.body == null || typeof init.body === 'string';
    const hibernated = response.status === 417 &&
      response.headers.get('x-anyrun-error-source') === 'anyrun-proxy' &&
      response.headers.get('x-anyrun-failure-reason') === 'pod_hibernated';
    if (!hibernated || !reads.has(method) || !replayable) return response;
    signal?.throwIfAborted();
    if (generation === startedGeneration && !pendingRefresh && now() < refreshAfter) return response;
    // Release the discarded proxy response before reconnecting. Cleanup failure
    // must not turn a safe read recovery into a new submission.
    await response.body?.cancel().catch(() => undefined);
    signal?.throwIfAborted();
    if (generation === startedGeneration && !pendingRefresh) {
      pendingRefresh = Promise.resolve().then(refresh).then(fresh => {
        Object.assign(session, fresh);
        rememberRoute();
        generation++;
      }).finally(() => {
        pendingRefresh = undefined;
        // Persistent 417s should not make each UI poll wake the sandbox again.
        refreshAfter = now() + 5000;
      });
    }
    // Cancelling one reader does not cancel the refresh shared by other readers.
    if (pendingRefresh) await waitForRefresh(pendingRefresh, signal);
    return attempt(); // Never recursively retry, and never replay sends/interrupts.
  };
}
