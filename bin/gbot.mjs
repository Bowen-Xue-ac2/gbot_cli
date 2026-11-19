#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const explicitTui = args[0] === 'tui';
if (explicitTui || args.length === 0 || ['--agent', '--check', '--mock'].includes(args[0])) {
  if (explicitTui) args.shift();
  process.argv = [process.execPath, process.argv[1], ...args];
  await import('../src/launch.mjs');
} else {
  const require = createRequire(import.meta.url);
  const cli = new URL('./dist/bin/gbot.mjs', pathToFileURL(require.resolve('grok-bot-cli/package.json')));
  const result = spawnSync(process.execPath, [fileURLToPath(cli), ...args], { stdio: 'inherit', windowsHide: true });
  if (result.error) console.error('Cannot start the installed Grok Bot CLI dependency.');
  process.exitCode = result.status ?? 1;
}
