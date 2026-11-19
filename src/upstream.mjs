import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
export const tuiPackage = pathToFileURL(require.resolve('grokbot-tui/package.json'));
const fromTui = createRequire(tuiPackage);
export const upstreamUrl = path => new URL(path, tuiPackage);
export const upstreamDependency = name => pathToFileURL(fromTui.resolve(name));
