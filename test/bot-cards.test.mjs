import { upstreamUrl } from '../src/upstream.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseBotCard, submitCardAction } from '../src/bot-cards.mjs';

test('changed or user-authored approvals cannot trigger an action', async () => {
  const entry = { id: 'card', kind: 'send-message', message: { type: 'auto-review-approval',
    approval: { status: 'pending', requestId: 'request', command: 'mock test' } } };
  const snapshot = parseBotCard(entry);
  assert.equal(parseBotCard({ ...entry, role: 'user' }), undefined);
  assert.equal(parseBotCard({ ...entry, message: { type: 'text', content: JSON.stringify(entry) } }), undefined);
  entry.message.approval.status = 'expired';
  const calls = [];
  await assert.rejects(submitCardAction(async method => {
    calls.push(method);
    return { entries: [entry] };
  }, 'mock-bot', snapshot, { name: 'approve' }, () => {}), /changed or expired/);
  assert.deepEqual(calls, ['getAgentTranscriptTail']);
});

test('actual Ink chat auto-renders bot cards and submits the action chosen on the original card', () => {
  const app = upstreamUrl('./').href;
  const adapter = new URL('../src/tui-chat.mjs', import.meta.url).href;
  const protocol = new URL('../src/bot-cards.mjs', import.meta.url).href;
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { createRequire, registerHooks } from 'node:module';
    import { pathToFileURL } from 'node:url';
    import { PassThrough } from 'node:stream';
    import { setTimeout as delay } from 'node:timers/promises';
    import { patchTuiChatSource, patchCardTranscript, patchCardLayout, patchCardPoll } from ${JSON.stringify(adapter)};
    import { submitCardAction } from ${JSON.stringify(protocol)};
    const app = ${JSON.stringify(app)};
    const fetchData = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      if (String(url).startsWith('data:')) return fetchData(url, init);
      throw new Error('Unexpected external network');
    };
    const patches = new Map([
      [app + 'dist/tui/Chat.js', patchTuiChatSource],
      [app + 'dist/client/transcript.js', patchCardTranscript],
      [app + 'dist/tui/layout.js', patchCardLayout],
      [app + 'dist/tui/poll.js', patchCardPoll],
    ]);
    registerHooks({ load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      const patch = patches.get(url);
      return patch ? { ...loaded, source: patch(Buffer.from(loaded.source).toString('utf8')) } : loaded;
    }});
    const require = createRequire(app + 'package.json');
    const { createElement } = await import(pathToFileURL(require.resolve('react')).href);
    const { render } = await import(pathToFileURL(require.resolve('ink')).href);
    const { Chat } = await import(app + 'dist/tui/Chat.js');
    const { turnsFromHostTranscript } = await import(app + 'dist/client/transcript.js');
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 120, rows: 46 });
    const stderr = new PassThrough();
    stderr.resume();
    let output = '';
    stdout.on('data', chunk => { output += chunk.toString(); });
    let entries = [
      { id: 'hello', kind: 'send-message', message: { type: 'text', content: 'Normal bot message' } },
      { id: 'choice', kind: 'send-message', message: { type: 'widget', widget: {
        prompt: 'Which option?', options: [{ label: 'Option one', value: 'first' }, { label: 'Option two', value: 'second' }],
      } } },
    ];
    const agent = { id: 'mock-bot', name: 'Mock Bot' };
    const writes = [];
    const prompts = [];
    const client = {
      listAgents: async () => [agent],
      getTranscript: async () => turnsFromHostTranscript({ entries }),
      sendPrompt: async ({ prompt }) => { prompts.push(prompt); return { accepted: true, status: 'idle' }; },
      actOnCard: (id, expected, action) => submitCardAction(async (method, body) => {
        if (method === 'getAgentTranscriptTail') return { entries };
        writes.push({ method, body });
        return {};
      }, id, expected, action, () => {}),
    };
    const view = render(createElement(Chat, { agent, client, pollMs: 30, onSwitch() {} }),
      { stdin, stdout, stderr, debug: true, exitOnCtrlC: false, patchConsole: false });
    async function until(predicate, label) {
      const deadline = Date.now() + 3000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, label + '\n' + output.slice(-2500));
        await delay(10);
      }
    }
    async function key(input) { stdin.write(input); await delay(90); }
    const down = '\x1b[B';
    const up = '\x1b[A';
    try {
      await until(() => output.includes('Which option?') && output.includes('[Option two]'), 'card appeared before keyboard input');
      assert.ok(output.indexOf('Normal bot message') < output.indexOf('Which option?'));
      await key('ordinary-chat');
      await key('\r');
      await until(() => prompts.length === 1, 'unfocused card leaves chat composer available');
      assert.equal(writes.length, 0);
      await key('\t');
      await key(down);
      await key('\r');
      await until(() => writes.length === 1, 'choice submitted');
      assert.deepEqual(writes[0], {
        method: 'respondToWidget', body: { agentId: 'mock-bot', entryId: 'choice', value: 'second' },
      });
      entries = [entries[0], { ...entries[1], respondedValue: 'second' }, {
        id: 'approval', kind: 'send-message', message: { type: 'local-tool-permission',
          ask: { requestId: 'req-1', status: 'pending', summary: 'Review mock tool' },
        },
      }];
      await until(() => output.includes('Status: answered') && output.includes('Review mock tool'), 'poll updates cards in chat');
      await key('\t');
      await key('\r');
      assert.equal(writes.length, 1, 'Enter alone makes no approval');
      await key(down);
      await key('\r');
      await until(() => writes.length === 2, 'explicit allow once');
      assert.deepEqual(writes[1], {
        method: 'resolveLocalToolPermission', body: {
          agentId: 'mock-bot', entryId: 'approval', requestId: 'req-1', resolution: 'allow-once',
        },
      });
      entries = [...entries, {
        id: 'draft', kind: 'send-message', message: { type: 'email-draft', draft: {
          to: ['mock@example.invalid'], subject: 'Draft subject', body: 'Draft body',
        } },
      }];
      await until(() => output.includes('Draft subject') && output.includes('mock@example.invalid'), 'email preview received');
      await key('\t');
      await key(down);
      await key(down);
      await key('\r');
      await until(() => output.includes('Ctrl+S save body'), 'edit body opens composer');
      await key(' revised');
      await key('\x13');
      await key(up);
      await key('\r');
      await until(() => output.includes('Press y to send this email'), 'email has distinct confirmation');
      assert.equal(writes.length, 2);
      await key('y');
      await until(() => writes.length === 3, 'explicit email confirmation');
      assert.deepEqual(writes[2], { method: 'sendDraft', body: { agentId: 'mock-bot', entryId: 'draft',
        draft: { to: ['mock@example.invalid'], subject: 'Draft subject', body: 'Draft body revised' },
      } });
      await key('\t');
      await key('y');
      assert.equal(writes.length, 3, 'awaiting host confirmation blocks duplicates');
      assert.deepEqual(prompts, ['ordinary-chat']);
    } finally {
      view.unmount();
      view.cleanup();
    }
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: script, encoding: 'utf8', windowsHide: true, timeout: 18000,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
});
