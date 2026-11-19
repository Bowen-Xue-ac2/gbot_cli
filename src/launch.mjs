import { mkdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { tuiPackage, upstreamUrl } from './upstream.mjs';
import { LauncherError, loadWindowsSession, protectGatewayFetch } from './windows-session.mjs';
import { patchTuiHostSource } from './backend-send.mjs';
import { patchCardHost, patchCardLayout, patchCardPoll, patchCardTranscript, patchTuiChatSource } from './tui-chat.mjs';

const moduleUrl = relative => upstreamUrl(relative).href;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--mock') && args.includes('--check')) {
    throw new LauncherError('arguments', 'Use --mock or --check separately.');
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Windows Grok Bot TUI launcher\n\n  gbot             Open bot/channel lobby\n  gbot --agent NAME Open one bot/channel\n  gbot --check      Read-only connection check (counts only)\n  gbot --mock       Offline TUI demo\n\nUses the active Grok Bot desktop account. Credentials stay in process memory.');
    return;
  }
  if (!args.includes('--check') && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new LauncherError('tty', 'Open this launcher in Windows Terminal or PowerShell. Use --check for a noninteractive check.');
  }
  let pkg;
  try { pkg = JSON.parse(readFileSync(tuiPackage, 'utf8')); } catch {
    throw new LauncherError('package', 'Cannot resolve the pinned grokbot-tui dependency. Run npm ci.');
  }
  // This hook is deliberately pinned: fail visibly if an upgrade changes the adapter.
  if (pkg.version !== '0.2.0') throw new LauncherError('version', 'This adapter supports grokbot-tui 0.2.0. Review it after an upgrade.');
  const sessionUrl = moduleUrl('dist/client/session.js');
  const patches = new Map([
    [moduleUrl('dist/client/host.js'), source => patchCardHost(patchTuiHostSource(source))],
    [moduleUrl('dist/client/transcript.js'), patchCardTranscript],
    [moduleUrl('dist/tui/Chat.js'), patchTuiChatSource],
    [moduleUrl('dist/tui/layout.js'), patchCardLayout],
    [moduleUrl('dist/tui/poll.js'), patchCardPoll],
  ]);
  const windowsUrl = new URL('./windows-session.mjs', import.meta.url).href;
  const marker = 'if (platform !== "darwin")\n        return null;';
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      const patch = patches.get(url);
      if (url !== sessionUrl && !patch) return loaded;
      const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
      if (patch) return { ...loaded, source: patch(source) };
      if (!source.includes(marker)) throw new LauncherError('adapter', 'The installed TUI session adapter changed. No package files were modified.');
      return { ...loaded, source: `import { loadWindowsSession } from ${JSON.stringify(windowsUrl)};\n` +
        source.replace(marker, `if (platform === "win32") return await loadWindowsSession();\n    ${marker}`) };
    },
  });

  if (!args.includes('--mock')) {
    // Ignore inherited gateway overrides in this dedicated active-account launcher.
    delete process.env.GROKBOT_GATEWAY_TOKEN;
    delete process.env.GROKBOT_GATEWAY_URL;
    delete process.env.GROK_TUI_MOCK;
    const session = await loadWindowsSession();
    globalThis.fetch = protectGatewayFetch(session);
    // The upstream CLI calls dotenv; prevent a project .env from changing this route.
    process.env.GROKBOT_GATEWAY_TOKEN = '';
    process.env.GROKBOT_GATEWAY_URL = '';
    process.env.GROK_TUI_MOCK = '0';
  }
  if (args.includes('--check')) {
    const { openHostClient } = await import(moduleUrl('dist/client/factory.js'));
    const host = await openHostClient({ config: { mock: false }, env: {} });
    let agents;
    try { agents = await host.listAgents(); } catch (error) {
      throw new LauncherError('gateway-connect', `Gateway listAgents failed${Number.isInteger(error.status) ? ` (HTTP ${error.status})` : ''}. Reopen Grok Bot and retry; no chat message was sent.`);
    }
    const groups = agents.filter(agent => agent.isGroup).length;
    console.log(JSON.stringify({ connected: true, tuiVersion: pkg.version, bots: agents.length - groups,
      channels: groups, credentialSource: 'active-windows-desktop-account', messagesSent: 0 }));
    return;
  }
  const runtimeRoot = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'gbot-cli');
  process.env.XDG_CACHE_HOME = join(runtimeRoot, 'cache');
  const tempRoot = join(runtimeRoot, 'temp');
  mkdirSync(tempRoot, { recursive: true });
  process.env.TEMP = tempRoot;
  process.env.TMP = tempRoot;
  await import(moduleUrl('dist/cli.js'));
}

main().catch(error => {
  console.error(error instanceof LauncherError ? `[${error.code}] ${error.message}` :
    '[unexpected] Launcher failed. No credentials or server response were printed.');
  process.exitCode = 1;
});
