import { upstreamUrl } from '../src/upstream.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { patchTuiChatSource } from '../src/tui-chat.mjs';

test('the version-pinned chat adapter refuses changed upstream code', () => {
  assert.throws(() => patchTuiChatSource('changed upstream'), { code: 'chat-adapter' });
  const source = readFileSync(upstreamUrl('dist/tui/Chat.js'), 'utf8');
  assert.throws(() => patchTuiChatSource(source.replace('// Rooms:', '// Changed:')), { code: 'chat-adapter' });
});

test('real Ink chat accepts another prompt before any bot reply and paints incremental replies (offline)', () => {
  const chatUrl = upstreamUrl('dist/tui/Chat.js').href;
  const adapterUrl = new URL('../src/tui-chat.mjs', import.meta.url).href;
  const packageUrl = upstreamUrl('package.json').href;
  const script = `
    import assert from 'node:assert/strict';
    import { createRequire, registerHooks } from 'node:module';
    import { pathToFileURL } from 'node:url';
    import { PassThrough } from 'node:stream';
    import { setTimeout as delay } from 'node:timers/promises';
    import { patchTuiChatSource } from ${JSON.stringify(adapterUrl)};
    globalThis.fetch = async () => { throw new Error('External requests forbidden in UI test'); };
    registerHooks({ load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      return url === ${JSON.stringify(chatUrl)}
        ? { ...loaded, source: patchTuiChatSource(Buffer.from(loaded.source).toString('utf8')) }
        : loaded;
    }});
    const require = createRequire(${JSON.stringify(packageUrl)});
    const { createElement } = await import(pathToFileURL(require.resolve('react')).href);
    const { render } = await import(pathToFileURL(require.resolve('ink')).href);
    const { Chat } = await import(${JSON.stringify(chatUrl)});
    async function until(predicate, description) {
      const deadline = Date.now() + 3000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, description);
        await delay(10);
      }
    }
    for (const isGroup of [false, true]) {
      const stdout = new PassThrough();
      Object.assign(stdout, { isTTY: true, columns: 110, rows: 35 });
      const stdin = new PassThrough();
      Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
      const stderr = new PassThrough();
      let output = '';
      stdout.on('data', chunk => { output += chunk.toString(); });
      stderr.resume();
      const agent = { id: 'fake-bot', name: 'Mock Bot', isGroup, isRunning: true };
      let history = [{ id: 'old', role: 'assistant', speaker: 'Mock Bot', text: 'old-response', timestampMs: 1 }];
      const calls = [];
      let release;
      let polls = 0;
      const client = {
        getTranscript: async () => { polls++; return history; },
        listAgents: async () => [agent],
        sendPrompt: input => {
          calls.push(input);
          return new Promise(resolve => { release = () => resolve({ accepted: true, status: 'idle' }); });
        },
      };
      const app = render(createElement(Chat, { client, agent, roster: [agent], pollMs: 20, onSwitch() {} }),
        { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false });
      try {
        await until(() => output.includes('old-response'), 'initial transcript paints');
        stdin.write('first-message');
        await delay(50);
        stdin.write('\\r');
        await until(() => calls.length === 1, 'first message submits');
        assert.equal(calls[0].wait, false, 'submission must not wait for the bot reply');
        release();
        await delay(70);
        // No reply or host echo yet: composition must already be unlocked.
        stdin.write('second-message');
        await delay(50);
        stdin.write('\\r');
        await until(() => calls.length === 2, 'second message submits before any bot reply');
        assert.equal(calls[1].prompt, 'second-message');
        assert.equal(calls[1].wait, false);
        release();
        await delay(70);
        assert.equal(history.length, 1, 'both sends completed without a bot response');
        const baseline = polls;
        const echo = (id, text, timestampMs) => ({ id, role: 'user', speaker: 'you', text, timestampMs });
        history = [...history, echo('echo-1', 'first-message', 2), echo('echo-2', 'second-message', 3),
          { id: 'reply', role: 'assistant', speaker: 'Mock Bot', text: 'mock-incremental-reply', timestampMs: 4 }];
        await until(() => output.includes('mock-incremental-reply'), 'background poll paints a partial reply');
        history = history.map(turn => turn.id === 'reply' ? { ...turn, text: 'mock-complete-reply' } : turn);
        await until(() => output.includes('mock-complete-reply'), 'background poll paints updates to the same reply');
        assert.ok(polls >= baseline + 2);
        assert.equal(calls.length, 2, 'receive polling never resubmits prompts');
      } finally {
        app.unmount();
        app.cleanup();
        stdin.destroy();
        stdout.destroy();
        stderr.destroy();
      }
    }
    console.log('nonblocking chat UI passed; external requests: 0');
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: script, encoding: 'utf8', windowsHide: true, timeout: 12000,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /nonblocking chat UI passed; external requests: 0/);
});
