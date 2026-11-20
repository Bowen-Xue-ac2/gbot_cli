// Protocol reference: smarzban/grokbot-tui#12 and #14 (SendGrokBotUserMessage).
import { randomUUID } from 'node:crypto';
import { LauncherError, loadWindowsSendCredentials } from './windows-session.mjs';
import { appCandidates } from './route-catalog.mjs';

export const SEND_URL = 'https://api2.cursor.sh/aiserver.v1.GrokBotService/SendGrokBotUserMessage';
const APP_LIST_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetAvailableMcpServers';
const APP_STATUS_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/ListSandMcpTools';
// launch.mjs imports this adapter before installing its gateway-origin fetch guard.
// The user-authenticated calls below have fixed destinations and refuse redirects.
const backendFetch = globalThis.fetch;
const machineId = randomUUID();
const hostMarker = 'const sent = await this.#call("sendPrompt", {';

export function patchTuiHostSource(source, senderUrl = import.meta.url) {
  if (source.split(hostMarker).length !== 2) {
    throw new LauncherError('send-adapter', 'The installed TUI sender changed. Refusing to use the obsolete gateway send endpoint.');
  }
  return `import { sendBackendPrompt } from ${JSON.stringify(senderUrl)};\n` +
    source.replace(hostMarker, 'const sent = await sendBackendPrompt({\n                richText: input.richText,');
}

export async function listConnectedApps(agentId, signal, options = {}) {
  signal?.throwIfAborted();
  const auth = (options.loadCredentials ?? loadWindowsSendCredentials)();
  const deadline = AbortSignal.timeout(15000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  async function read(url, body) {
    const response = await (options.fetchImpl ?? backendFetch)(url, {
      method: 'POST', redirect: 'error', signal: requestSignal,
      headers: {
        'content-type': 'application/json', 'connect-protocol-version': '1',
        authorization: 'Bearer ' + auth.accessToken, 'x-cursor-client-type': 'sand',
        'x-cursor-client-version': auth.clientVersion, 'x-sand-box-namespace': 'prod',
        ...(auth.teamId === undefined ? {} : { 'x-cursor-team-id': auth.teamId }),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new LauncherError('app-catalog', 'Could not read connected Grok Bot apps.');
    return response.json();
  }
  const [account, scoped] = await Promise.all([read(APP_LIST_URL, {}), read(APP_LIST_URL, { grokBotAgentId: agentId })]);
  const candidates = appCandidates(account, scoped);
  const unknown = candidates.filter(app => !app.connected && app.identifier).map(app => app.identifier);
  const active = new Set();
  let partial = false;
  if (unknown.length) {
    try {
      const report = await read(APP_STATUS_URL, { serverIdentifiers: [...new Set(unknown)] });
      for (const server of report.servers ?? []) {
        if (server.status === 'connected') {
          if (server.serverIdentifier) active.add(server.serverIdentifier);
          if (server.rowServerIdentifier) active.add(server.rowServerIdentifier);
        }
      }
    } catch {
      signal?.throwIfAborted();
      partial = true;
    }
  }
  const items = candidates.filter(app => app.connected || active.has(app.identifier)).map(app => app.item);
  return { items, partial };
}

function varint(number) {
  let value = BigInt(number);
  if (value < 0n) throw new Error('negative protobuf value');
  const bytes = [];
  do {
    const byte = Number(value & 127n);
    value >>= 7n;
    bytes.push(value ? byte | 128 : byte);
  } while (value);
  return Buffer.from(bytes);
}

function numberField(field, value) {
  return Buffer.concat([varint(field * 8), varint(value)]);
}

function stringField(field, value) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
}

export function encodeSendRequest(input, sentAtMs = Date.now(), clientMachineId = machineId) {
  // source=DESKTOP, send_source=CHAT match the app protocol (no terminal enum).
  // session_id (15) must remain unset: an invented session ID selects no agent.
  return Buffer.concat([
    stringField(1, input.agentId), stringField(2, input.clientNonce), stringField(3, input.prompt),
    numberField(4, sentAtMs), ...(input.richText ? [stringField(5, input.richText)] : []),
    numberField(13, 1), stringField(16, clientMachineId),
    stringField(20, 'en'), numberField(21, 1),
  ]);
}

function readFields(bytes) {
  let offset = 0;
  const fields = new Map();
  function next() {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= bytes.length) throw new Error('truncated varint');
      const byte = bytes[offset++];
      if (shift === 63n && byte > 1) throw new Error('oversized varint');
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error('oversized varint');
  }
  while (offset < bytes.length) {
    const tag = next();
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field < 1 || field > 536870911) throw new Error('invalid field');
    if (wire === 0) {
      fields.set(field, next());
      continue;
    }
    const length = wire === 2 ? Number(next()) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
    if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - offset) {
      throw new Error('truncated or unsupported field');
    }
    if (wire === 2) fields.set(field, bytes.subarray(offset, offset + length));
    offset += length;
  }
  return fields;
}

function sendError(code, message, delivery, status) {
  return Object.assign(new LauncherError(code, message), { delivery, ...(status ? { status } : {}) });
}

const unknownMessage = 'SendGrokBotUserMessage delivery unknown. Check the bot thread before resending; no automatic retry was made.';

export function assertAccepted(bytes) {
  let fields;
  try {
    if (bytes.length > 65536) throw new Error('oversized response');
    fields = readFields(bytes);
  } catch {
    throw sendError('send-response', unknownMessage, 'unknown');
  }
  const delivery = fields.get(4);
  if (delivery === 1n || delivery === 2n || delivery === 3n) return;
  if (delivery === 4n) {
    throw sendError('send-refused', 'SendGrokBotUserMessage refused the message. Check the bot/team and the desktop app.', 'rejected');
  }
  throw sendError('send-response', unknownMessage, 'unknown');
}

export async function sendBackendPrompt(input, signal, options = {}) {
  if (!input || !['agentId', 'prompt', 'clientNonce'].every(key => typeof input[key] === 'string') ||
      !input.agentId || !input.clientNonce) {
    throw sendError('send-input', 'The TUI supplied an incomplete message; nothing was sent.', 'rejected');
  }
  signal?.throwIfAborted();
  const auth = (options.loadCredentials ?? loadWindowsSendCredentials)();
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(30000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let response;
  let bytes;
  try {
    response = await (options.fetchImpl ?? backendFetch)(SEND_URL, {
      method: 'POST', redirect: 'error', signal: requestSignal,
      headers: {
        'content-type': 'application/proto', 'connect-protocol-version': '1',
        authorization: `Bearer ${auth.accessToken}`, 'x-cursor-client-type': 'sand',
        'x-cursor-client-version': auth.clientVersion, 'x-cursor-client-os': process.platform,
        'x-cursor-client-source': 'sand-desktop', 'x-sand-box-namespace': 'prod',
        'x-ghost-mode': 'true', 'x-request-id': randomUUID(),
        ...(auth.teamId === undefined ? {} : { 'x-cursor-team-id': auth.teamId }),
      },
      body: encodeSendRequest(input),
    });
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    // A timeout/disconnect does not establish whether the server received the nonce.
    throw sendError('send-network', unknownMessage, 'unknown');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw sendError('send-auth', `SendGrokBotUserMessage returned HTTP ${response.status}. Check the active Grok Bot desktop login and team. No automatic retry was made.`, 'rejected', response.status);
    }
    const rejected = response.status >= 400 && response.status < 500;
    throw sendError('send-http', `SendGrokBotUserMessage returned HTTP ${response.status}. ` +
      (rejected ? 'The message was rejected; no automatic retry was made.' : unknownMessage),
    rejected ? 'rejected' : 'unknown', response.status);
  }
  assertAccepted(bytes);
  return { accepted: true, clientNonce: input.clientNonce };
}
