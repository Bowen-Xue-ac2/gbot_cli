import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';
import { upstreamUrl, upstreamDependency } from '../src/upstream.mjs';
const { default: React } = await import(upstreamDependency('react'));
const { render } = await import(upstreamDependency('ink'));
const { InkPictureProvider } = await import(upstreamDependency('ink-picture'));
import { patchCardLayout, patchTuiChatSource } from '../src/tui-chat.mjs';

const layoutUrl = upstreamUrl('dist/tui/layout.js').href;
const chatUrl = upstreamUrl('dist/tui/Chat.js').href;
const patches = new Map([[layoutUrl, patchCardLayout], [chatUrl, patchTuiChatSource]]);
const hook = registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  const patch = patches.get(url);
  return patch ? { ...loaded, source: patch(Buffer.from(loaded.source).toString('utf8')) } : loaded;
} });
const { turnsToRows } = await import(layoutUrl);
const { Chat } = await import(chatUrl);
hook.deregister();
const turn = text => ({ id: 'example', role: 'assistant', speaker: 'Bot', text });
const rowsFor = (text, width = 100, options) => turnsToRows([turn(text)], width, 'Bot', options);
const body = rows => rows.map(row => row.text).join('\n');
const fence = '```';
const diagram = [fence + 'mermaid', 'flowchart LR', '  A[Start] --> B[Done]', fence].join('\n');

test('renders the diagram at its position in the message and retains exact source on request', () => {
  const text = 'Before diagram\n' + diagram + '\nAfter diagram';
  const output = body(rowsFor(text));
  assert.match(output, /Before diagram[\s\S]*┌[\s\S]*Start[\s\S]*Done[\s\S]*After diagram/);
  assert.doesNotMatch(output, /flowchart LR/);
  assert.match(body(rowsFor(text, 100, { source: true })), /  A\[Start\] --> B\[Done\]/);
  assert.match(body(rowsFor(diagram, 24)), /flowchart LR/);
});

test('inline math and block fractions render as terminal characters while source stays available', () => {
  const tex = String.raw`Lead $x^2 + \alpha$ and \(\Delta Q\).
$$
MC=\frac{\Delta TC}{\Delta Q}
$$
Tail`;
  const rows = rowsFor(tex);
  assert.equal(body(rows), 'Lead x² + α and ΔQ.\n     ΔTC\nMC = ───\n      ΔQ\nTail');
  assert.equal(body(rowsFor(tex, 100, { source: true })), tex);
  assert.ok(rows.every(row => row.kind !== 'picture'), 'formula rows are text throughout');
});

test('the reported cost, revenue and elasticity formulas preserve operators, fractions and percentages', () => {
  const costs = String.raw`$$AFC=\frac{FC}{Q},\qquad AVC=\frac{VC}{Q},\qquad ATC=AFC+AVC$$`;
  const revenue = String.raw`$$TR=P\times Q$$`;
  const elasticity = String.raw`$$E_d=\frac{\%\Delta Q}{\%\Delta P}=\frac{-10\%}{20\%}=-0.5$$`;
  const rendered = body(rowsFor([costs, revenue, elasticity].join('\n\n')));
  assert.match(rendered, /AFC = ──,\s+AVC = ──,\s+ATC = AFC \+ AVC/);
  assert.match(rendered, /TR = P × Q/);
  assert.match(rendered, /%ΔQ\s+−10%[\s\S]*=\s+───\s+=\s+────\s+=\s+−0\.5[\s\S]*d\s+%ΔP\s+20%/);
  assert.doesNotMatch(rendered, /\\|\$\$/);
});

test('display matrices and determinants keep their columns and enclosing delimiters', () => {
  const square = String.raw`$$A=\begin{pmatrix}1&20\\300&4\end{pmatrix}$$`;
  assert.equal(body(rowsFor(square)), 'A = ⎛  1   20 ⎞\n    ⎝ 300   4 ⎠');
  assert.equal(body(rowsFor(square, 100, { source: true })), square);
  const bracketed = String.raw`$$A=[\begin{matrix}1&20\\300&4\end{matrix}]$$`;
  assert.equal(body(rowsFor(bracketed)), 'A = ⎡  1   20 ⎤\n    ⎣ 300   4 ⎦');

  const determinant = String.raw`$$\begin{vmatrix}1&2\\3&4\end{vmatrix}$$`;
  assert.equal(body(rowsFor(determinant)), '│ 1  2 │\n│ 3  4 │');

  const fractions = String.raw`$$\begin{bmatrix}\frac{1}{2}&0\\-3&x_i\end{bmatrix}$$`;
  const output = body(rowsFor(fractions));
  assert.match(output, /^⎡\s+1\s+⎤\n⎢\s+─\s+0\s+⎥\n⎢\s+2\s+⎥\n⎣\s+−3\s+xᵢ\s+⎦$/);

  const piecewise = String.raw`$$\begin{cases}1&x>0\\0&x=0\end{cases}$$`;
  assert.equal(body(rowsFor(piecewise)), piecewise, 'a piecewise expression does not become a matrix');
});

test('inline matrices and narrow panes use compact notation with explicit row separators', () => {
  const inline = String.raw`Then \(A=\begin{bmatrix}1&0\\0&1\end{bmatrix}\).`;
  assert.equal(body(rowsFor(inline)), 'Then A = [1, 0; 0, 1].');
  const wide = String.raw`$$\begin{bmatrix}123456789&234567890\\345678901&456789012\end{bmatrix}$$`;
  const output = body(rowsFor(wide, 24));
  assert.equal(output.replace(/\n/g, ' '), '[123456789, 234567890; 345678901, 456789012]');
  assert.ok(output.split('\n').every(line => line.length <= 21));
});

test('a narrow viewport uses grouped one-line math for wide fractions and keeps unsupported TeX visible', () => {
  const formula = String.raw`$$+\frac{a_{1}+b_{2}}{2x}+\frac{c+d+e+f}{2y}$$`;
  const output = body(rowsFor(formula, 26));
  assert.match(output, /\(a₁ \+ b₂\)\/\(2x\)/);
  assert.doesNotMatch(output, /\\frac|─/);
  const unsupported = String.raw`$$\definitelyunknown{5}$$`;
  assert.equal(body(rowsFor(unsupported)), unsupported);
});

test('the reader lays out headings, emphasis, lists, quotes and tables rather than displaying their syntax', () => {
  const text = [
    '### 成本与需求', '燃油涨价会提高**每班成本**，这里有 *重点*。',
    '', '- 第一个原因', '  - [x] 已核对', '', '> 这是引用。',
    '', '| 项目 | 变化 |', '| --- | --- |', '| 客运收入 | 16% |',
  ].join('\n');
  const rows = rowsFor(text);
  const output = body(rows);
  assert.match(output, /^成本与需求\n/);
  assert.match(output, /燃油涨价会提高每班成本，这里有 重点。/);
  assert.match(output, /• 第一个原因[\s\S]*✓ 已核对/);
  assert.match(output, /│ 这是引用。/);
  assert.match(output, /项目[\s\S]*客运收入[\s\S]*16%/);
  assert.doesNotMatch(output, /###|\*\*|---|\[x\]/);
  assert.ok(rows.flatMap(row => row.spans ?? []).some(span => span.text === '每班成本' && span.style?.bold));
  assert.ok(rows.flatMap(row => row.spans ?? []).some(span => span.text === '重点' && span.style?.italic));
  assert.match(body(rowsFor(text, 100, { source: true })), /### 成本与需求[\s\S]*\*\*每班成本\*\*/);
});

test('unclosed blocks, prices, code and structured cards stay literal', () => {
  const unfinished = diagram.slice(0, -(fence.length + 1));
  const text = ['Price is $5 or $10.', 'Code: ' + '`$x^2$`', fence + 'js', '$x^2$', fence, unfinished].join('\n');
  assert.match(body(rowsFor(text)), /Price is \$5 or \$10\./);
  assert.match(body(rowsFor(text)), /Code: \$x\^2\$/);
  assert.match(body(rowsFor(text)), /\n\$x\^2\$\n/);
  assert.match(body(rowsFor(text)), /flowchart LR/);
  assert.doesNotMatch(body(rowsFor(text)), /┌/);
  assert.match(body(rowsFor('$$\nx^2')), /\$\$\nx\^2/);
  const code = 'Code: ``data ` and ` $x^2$ remain literal``';
  assert.equal(body(rowsFor(code)), 'Code: data ` and ` $x^2$ remain literal');
  const cardRows = turnsToRows([{ ...turn('$x^2$'), card: { entryId: 'card' } }], 100, 'Bot');
  assert.equal(body(cardRows), '$x^2$');
});

test('a powered fraction retains its grouping in a single terminal line', () => {
  const code = String.raw`$\frac{1}{2}^2$`;
  assert.equal(body(rowsFor(code)), '(1/2)²');
});

test('reader keeps HTTP link targets through wrapping, with literal code and unsafe schemes inactive', () => {
  const source = [
    'Read [**the wrapped documentation**](https://example.com/docs) and https://example.com/page.',
    '<http://example.com/auto>',
    '[Local](/path) [Mail](mailto:test@example.com) [FTP](ftp://example.com/file)',
    'Code: ' + '\x60https://example.com/code\x60',
  ].join('\n');
  const hrefs = rows => rows.flatMap(row => row.spans).map(span => span.href).filter(Boolean);
  const links = hrefs(rowsFor(source, 24));
  assert.ok(links.filter(href => href === 'https://example.com/docs').length > 1);
  assert.deepEqual([...new Set(links)], ['https://example.com/docs', 'https://example.com/page', 'http://example.com/auto']);
  assert.deepEqual(hrefs(rowsFor(source, 100, { source: true })), []);
});

test('clicking the rendered link opens its URL once while adjacent text, dragging and source view do not', async t => {
  const url = 'https://example.com/docs?topic=a%20b&part=2#ref';
  const opens = [];
  t.mock.method(childProcess, 'execFile', (_program, args, options, callback) => {
    assert.equal(args.at(-1), 'Start-Process -FilePath $env:GBOT_BROWSER_URL -ErrorAction Stop');
    opens.push(options.env.GBOT_BROWSER_URL);
    callback(null);
  });
  syncBuiltinESMExports();
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 110, rows: 35 });
  const stderr = new PassThrough();
  stderr.resume();
  let frame = '';
  stdout.on('data', chunk => {
    const output = stripVTControlCharacters(chunk.toString());
    if (output.includes('Ctrl+R')) frame = output;
  });
  const agent = { id: 'example', name: 'Bot' };
  const roster = [agent];
  const client = {
    getTranscript: async () => [turn('查看 [**Documentation**](' + url + ') then continue.')],
    listAgents: async () => roster,
  };
  const app = render(React.createElement(Chat, { client, agent, roster, onSwitch() {} }),
    { stdin, stdout, stderr, debug: true, exitOnCtrlC: false, patchConsole: false });
  async function until(predicate, description) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, description);
      await delay(10);
    }
  }
  function point(label) {
    const lines = frame.split('\n');
    const y = lines.findIndex(line => line.includes(label));
    assert.ok(y >= 0);
    return { x: stringWidth(lines[y].slice(0, lines[y].indexOf(label))) + 1, y: y + 1 };
  }
  const mouse = ({ x, y }, type) => stdin.write('\x1b[<0;' + x + ';' + y + type);
  try {
    await until(() => frame.includes('Documentation'), 'initial reader frame');
    const link = point('Documentation');
    const adjacent = point('then continue');
    mouse(adjacent, 'M');
    mouse(adjacent, 'm');
    mouse(link, 'M');
    mouse(adjacent, 'm');
    mouse(link, 'M');
    mouse(link, 'm');
    await until(() => opens.length > 0, 'click opens the link');
    assert.deepEqual(opens, [url]);
    stdin.write('\x12');
    await until(() => frame.includes('**Documentation**'), 'source frame');
    const source = point(url);
    mouse(source, 'M');
    mouse(source, 'm');
    stdin.write('\x12');
    await until(() => !frame.includes('**Documentation**'), 'reader frame restored');
    assert.deepEqual(opens, [url]);
  } finally {
    app.unmount();
    app.cleanup();
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('real Ink chat keeps LaTeX in the text frame during redraws and toggles the Markdown source', async () => {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 110, rows: 35 });
  const stderr = new PassThrough();
  stderr.resume();
  let output = '';
  stdout.on('data', chunk => { output += chunk.toString(); });
  const formula = String.raw`$$\frac{1}{2}$$`;
  const matrix = String.raw`$$\begin{bmatrix}1&2\\3&4\end{bmatrix}$$`;
  const source = ['### Section', '**Bold** line', diagram, formula, matrix].join('\n');
  const agent = { id: 'bot', name: 'Bot' };
  const roster = [agent];
  let history = [turn(source)];
  const client = { getTranscript: async () => history, listAgents: async () => roster };
  const terminalInfo = { supportsSixelGraphics: true, supportsKittyGraphics: false,
    supportsITerm2Graphics: false, supportsUnicode: true, supportsColor: true, cellWidth: 8, cellHeight: 16,
    terminalWidth: 880, terminalHeight: 560 };
  const view = render(React.createElement(InkPictureProvider, { terminalInfo },
    React.createElement(Chat, { client, agent, roster, pollMs: 50, onSwitch() {} })),
  { stdin, stdout, stderr, debug: true, exitOnCtrlC: false, patchConsole: false });
  async function waitFor(predicate, description) {
    const until = Date.now() + 3600;
    while (!predicate()) {
      assert.ok(Date.now() < until, description);
      await delay(15);
    }
  }
  function showsFraction(frame) {
    const rows = stripVTControlCharacters(frame).split(/\r?\n/)
      .map(line => line.trim().replace(/^│|│$/g, '').trim());
    return rows.some((line, i) => line === '─' && rows[i - 1] === '1' && rows[i + 1] === '2');
  }
  function showsMatrix(frame) {
    const text = stripVTControlCharacters(frame);
    return text.includes('⎡ 1  2 ⎤') && text.includes('⎣ 3  4 ⎦');
  }
  try {
    await waitFor(() => /Start/.test(output) && showsFraction(output) && showsMatrix(output),
      'terminal shows a diagram, a stacked fraction, and both matrix rows');
    assert.doesNotMatch(output, /### Section|\*\*Bold\*\*/);
    assert.doesNotMatch(output, /\\frac/);
    history = [...history, { ...turn('An incremental update'), id: 'new' }];
    await waitFor(() => output.includes('An incremental update'), 'a background poll redraws the chat');
    assert.doesNotMatch(output, /\x1bP[0-9;]*q|\x1b_G/, 'formulas do not paint outside the text frame');
    const beforeSource = output.length;
    stdin.write('\x12');
    await waitFor(() => output.slice(beforeSource).includes('### Section') &&
      output.slice(beforeSource).includes('flowchart LR') &&
      output.slice(beforeSource).includes(formula) && output.slice(beforeSource).includes(matrix),
      'Ctrl+R shows original source');
    const beforePreview = output.length;
    stdin.write('\x12');
    await waitFor(() => output.slice(beforePreview).includes('Start') &&
      showsFraction(output.slice(beforePreview)) && showsMatrix(output.slice(beforePreview)),
      'Ctrl+R restores the reader');
    assert.doesNotMatch(output.slice(beforePreview), /### Section|\\frac|\x1bP[0-9;]*q|\x1b_G/);
  } finally {
    view.unmount();
    view.cleanup();
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
  }
});
