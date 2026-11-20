import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { upstreamDependency, upstreamUrl } from '../src/upstream.mjs';
import { agentRoutes, appCandidates, skillRoutes } from '../src/route-catalog.mjs';
import { completeRoute, richTextForDraft, routeQuery, trackRouteEdit } from '../src/route-draft.mjs';
import { listConnectedApps } from '../src/backend-send.mjs';
import { patchTuiChatSource } from '../src/tui-chat.mjs';

const input = text => ({ text, caret: text.length });
const alice = { kind: 'agent', id: 'agent-a', label: 'Alice' };
const notes = { kind: 'skill', id: 'workflow-notes', label: 'Meeting notes' };
const calendar = { kind: 'app', id: 'mcp:41', label: 'Calendar' };
const nodeList = draft => JSON.parse(richTextForDraft(draft)).content.flatMap(p => p.content);

test('selected IDs follow edits and multiline text, while typed or edited labels stay literal', () => {
  for (const text of ['a@example.com', 'https://example.org/path', '/usr/bin', 'C:/work', '2/3']) {
    assert.equal(routeQuery(input(text)), null);
  }
  const first = completeRoute({ text: ' @alce end', caret: 4 }, alice);
  assert.equal(first.text, ' @Alice end');
  assert.equal(first.caret, 8);
  assert.equal(routeQuery({ ...first, caret: 4 }), null);
  const more = trackRouteEdit(first, input(first.text + '\n/meet'));
  const second = completeRoute(more, notes);
  assert.deepEqual(nodeList(second).filter(x => x.attrs).map(x => x.attrs.id), [alice.id, notes.id]);
  assert.equal(JSON.parse(richTextForDraft(second)).content.length, 2);
  const before = { ...second, caret: 0 };
  const moved = trackRouteEdit(before, { text: 'Go' + before.text, caret: 2 });
  assert.deepEqual(nodeList(moved).filter(x => x.attrs).map(x => x.attrs.id), [alice.id, notes.id]);
  const inside = { ...moved, caret: moved.text.indexOf('Alice') + 2 };
  const edited = trackRouteEdit(inside, {
    text: inside.text.slice(0, inside.caret) + 'X' + inside.text.slice(inside.caret), caret: inside.caret + 1,
  });
  assert.deepEqual(nodeList(edited).filter(x => x.attrs).map(x => x.attrs.id), [notes.id]);
  assert.equal(richTextForDraft(input('@Alice /Meeting notes')), undefined);
});

test('room targets stay within membership and account apps respect overrides and connection state', () => {
  const a = { id: 'a', name: 'Ada' };
  const b = { id: 'b', name: 'Bea' };
  const outsider = { id: 'c', name: 'Another bot' };
  const room = { id: 'room', name: 'Room', isGroup: true, memberIds: ['a','b'] };
  const roster = [a,b,outsider,room];
  assert.deepEqual(agentRoutes(room, roster).map(row => row.id), ['a','b']);
  assert.deepEqual(agentRoutes(outsider, roster).map(row => row.id), ['a','b']);
  assert.deepEqual(skillRoutes({ workflows: [{ id: 'x', name: 'Notes', body: 'private body' }] }),
    [{ kind: 'skill', id: 'x', label: 'Notes' }]);
  const connected = { id: 41, name: 'Calendar', enabled: true, accounts: [{ userHasAccessToken: true }] };
  const personal = { servers: [connected, { ...connected, id: 42, accounts: [] },
    { ...connected, id: 43 }, { ...connected, id: 44, needsGrant: true },
    { ...connected, id: 45, disabledByCloudAgentMcpAllowlist: true }] };
  const scoped = { servers: [{ ...connected, id: 43, disabledByTeamAdminPolicy: true },
    { ...connected, id: 10, servedBy: 'MCP_SERVED_BY_GROK', serverIdentifier: 'g-demo' }] };
  assert.deepEqual(appCandidates(personal, scoped).filter(app => app.connected).map(app => app.item.id),
    ['mcp:41', 'mcp:grok:g-demo']);
});

test('app picker reads metadata for the account and current bot using only the fixed service', async () => {
  const calls = [];
  const result = await listConnectedApps('agent-a', undefined, {
    loadCredentials: () => ({ accessToken: 'fixture', clientVersion: '0.1.0', teamId: '100' }),
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetAvailableMcpServers');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers['x-cursor-team-id'], '100');
      const body = JSON.parse(init.body);
      calls.push(body);
      return Response.json(body.grokBotAgentId ? {} : {
        servers: [{ id: 41, name: 'Calendar', enabled: true, userHasAccessToken: true }],
      });
    },
  });
  assert.deepEqual(calls, [{}, { grokBotAgentId: 'agent-a' }]);
  assert.deepEqual(result, { items: [calendar], partial: false });
});

test('apps without stored credentials need a connected server status; discovery never runs a tool', async () => {
  const list = statusReply => listConnectedApps('bot', undefined, {
    loadCredentials: () => ({ accessToken: 'fixture', clientVersion: '1.0.0' }),
    fetchImpl: async (url, { body }) => {
      if (url.endsWith('/GetAvailableMcpServers')) return Response.json(JSON.parse(body).grokBotAgentId ? {} : {
        servers: ['public-docs', 'signed-out'].map((name, id) => ({ name, id, enabled: true, serverIdentifier: name })),
      });
      assert.equal(url, 'https://api2.cursor.sh/aiserver.v1.DashboardService/ListSandMcpTools');
      assert.deepEqual(JSON.parse(body), { serverIdentifiers: ['public-docs', 'signed-out'] });
      return statusReply;
    },
  });
  assert.deepEqual(await list(Response.json({ servers: [
    { serverIdentifier: 'public-docs', status: 'connected' }, { serverIdentifier: 'signed-out', status: 'needsAuth' },
  ] })), { items: [{ kind: 'app', id: 'mcp:0', label: 'public-docs' }], partial: false });
  assert.deepEqual(await list(new Response('', { status: 503 })), { items: [], partial: true });
});

test('Ink inserts agent, skill and app references and sends them together only on submit', async () => {
  const chat = upstreamUrl('dist/tui/Chat.js').href;
  const hooks = registerHooks({ load(url, context, next) {
    const result = next(url, context);
    return url === chat ? { ...result, source: patchTuiChatSource(Buffer.from(result.source).toString('utf8')) } : result;
  } });
  const { Chat } = await import(chat);
  const { createElement } = await import(upstreamDependency('react'));
  const { render } = await import(upstreamDependency('ink'));
  const agent = { id: 'current', name: 'Current' };
  const twinId = 'agent-b';
  const roster = [agent, { id: alice.id, name: alice.label }, { id: twinId, name: alice.label }];
  const calls = [];
  const reads = [];
  const client = {
    listAgents: async () => roster, getTranscript: async () => [],
    listRouteSkills: async id => { reads.push(['skills', id]); return [notes]; },
    listRouteApps: async id => { reads.push(['apps', id]); return [calendar]; },
    sendPrompt: async message => { calls.push(message); return { accepted: true, status: 'idle' }; },
  };
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 110, rows: 34 });
  const stderr = new PassThrough();
  stderr.resume();
  let frame = '';
  stdout.on('data', data => { frame += data.toString(); });
  const view = render(createElement(Chat, { client, agent, roster, pollMs: 50, onSwitch() {} }),
    { stdin, stdout, stderr, debug: true, exitOnCtrlC: false, patchConsole: false });
  async function until(check, label) {
    const end = Date.now() + 4000;
    while (!check()) { assert.ok(Date.now() < end, label); await delay(15); }
  }
  async function key(text) { stdin.write(text); await delay(65); }
  try {
    await until(() => frame.includes('No messages yet'), 'chat opened');
    await key('@');
    await until(() => frame.includes('Calendar  [app]') && frame.includes('Alice  [agent · agent-b]'), '@ menu');
    await key('\x1b[B');
    await key('\t');
    await key('/meeting n');
    await until(() => frame.includes('Meeting notes  [skill]'), '/ menu');
    await key('\r');
    await key('@cal');
    await key('\r');
    assert.equal(calls.length, 0);
    await key('prepare');
    await key('\r');
    await until(() => calls.length === 1, 'explicit send');
    const message = calls[0];
    assert.equal(message.prompt, '@Alice @Meeting notes @Calendar prepare');
    assert.equal(message.agentId, agent.id);
    assert.equal(message.wait, false);
    assert.deepEqual(JSON.parse(message.richText).content[0].content.filter(n => n.attrs),
      [{ type: 'mention', attrs: { id: twinId, label: alice.label, mentionSuggestionChar: '@' } },
        ...[notes, calendar].map(item => ({ type: 'workflowReference',
          attrs: { id: item.id, label: item.label, iconId: null, iconUrl: null } }))]);
    assert.deepEqual(reads, [['apps', agent.id], ['skills', agent.id]]);
    await key('/missing');
    await until(() => frame.includes('No matching skills'), 'empty results feedback');
    await key('\x1b');
    await key('\r');
    await until(() => calls.length === 2, 'literal send');
    assert.equal(calls[1].prompt, '/missing');
    assert.equal(calls[1].richText, undefined);
  } finally {
    view.unmount();
    view.cleanup();
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
    hooks.deregister();
  }
});
