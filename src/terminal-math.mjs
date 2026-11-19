import { mathjax } from '@mathjax/src/js/mathjax.js';
import { TeX } from '@mathjax/src/js/input/tex.js';
import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js';
import { STATE } from '@mathjax/src/js/core/MathItem.js';
import { TEXCLASS } from '@mathjax/src/js/core/MmlTree/MmlNode.js';
import '@mathjax/src/js/input/tex/ams/AmsConfiguration.js';
import stringWidth from 'string-width';

const MAX_TEX = 4096;
const MAX_CELLS = 256;
const MAX_ROWS = 16;
const cache = new Map();
RegisterHTMLHandler(liteAdaptor());
const document = mathjax.document('', {
  InputJax: new TeX({
    packages: ['base', 'ams'], maxBuffer: MAX_TEX, maxMacros: 512,
    formatError: (_jax, error) => { throw error; },
  }),
});

const superscript = [
  '0123456789+-−=()in',
  '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁻⁼⁽⁾ⁱⁿ',
];
const subscript = [
  '0123456789+-−=()aehijklmnoprstuvx',
  '₀₁₂₃₄₅₆₇₈₉₊₋₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ',
];
const blackboard = { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' };
const supportedContainers = new Set(['math', 'mrow', 'inferredMrow', 'TeXAtom', 'mstyle', 'mpadded', 'mtd']);
const atom = /^[+−]?(?:\d+(?:\.\d+)?%?|\p{L}[\u2070-\u209f]*)$/u;
const matrixFences = new Map([
  ['(', { close: ')', left: '⎛⎜⎝', right: '⎞⎟⎠' }],
  ['[', { close: ']', left: '⎡⎢⎣', right: '⎤⎥⎦' }],
  ['{', { close: '}', left: '⎧⎪⎩', right: '⎫⎪⎭', middle: ['⎨', '⎬'] }],
  ['|', { close: '|', left: '│││', right: '│││' }],
  ['‖', { close: '‖', left: '‖‖‖', right: '‖‖‖' }],
]);
const fenceChars = new Set([...matrixFences.keys(), ...[...matrixFences.values()].map(fence => fence.close)]);
const fenceText = node => node?.kind === 'mo' ? node.getText() : undefined;
const isFence = node => node?.kind === 'mo' &&
  ([TEXCLASS.OPEN, TEXCLASS.CLOSE].includes(node.texClass) || fenceChars.has(node.getText()));

function box(lines, baseline = 0) {
  const width = Math.max(...lines.map(line => stringWidth(line)));
  if (width > MAX_CELLS || lines.length > MAX_ROWS) throw new Error('Terminal math layout is too large');
  return { lines, baseline, width };
}

const text = value => box([value]);
const pad = (line, width) => line + ' '.repeat(Math.max(0, width - stringWidth(line)));
const center = (line, width) => {
  const left = Math.ceil((width - stringWidth(line)) / 2);
  return pad(' '.repeat(Math.max(0, left)) + line, width);
};

function join(boxes) {
  if (!boxes.length) return text('');
  if (boxes.length === 1) return boxes[0];
  const baseline = Math.max(...boxes.map(part => part.baseline));
  const height = baseline + Math.max(...boxes.map(part => part.lines.length - part.baseline));
  if (height > MAX_ROWS || boxes.reduce((n, part) => n + part.width, 0) > MAX_CELLS) {
    throw new Error('Terminal math layout is too large');
  }
  return box(Array.from({ length: height }, (_, row) => boxes.map(part =>
    pad(part.lines[row - baseline + part.baseline] ?? '', part.width)).join('')), baseline);
}

function stack(top, middle, bottom) {
  const width = Math.max(top?.width ?? 0, middle.width, bottom?.width ?? 0);
  const lines = [top, middle, bottom].flatMap(part => part ? part.lines.map(line => center(line, width)) : []);
  return box(lines, (top?.lines.length ?? 0) + middle.baseline);
}

function glyphs(value, [from, to]) {
  if (value == null) return '';
  let result = '';
  for (const char of value) {
    const index = from.indexOf(char);
    if (index === -1) return undefined;
    result += to[index];
  }
  return result;
}

function group(value) {
  return atom.test(value) ? value : '(' + value + ')';
}

function scripts(base, sub, sup, display) {
  const low = sub?.lines.length === 1 ? sub.lines[0] : undefined;
  const high = sup?.lines.length === 1 ? sup.lines[0] : undefined;
  const lowGlyphs = sub && low === undefined ? undefined : glyphs(low, subscript);
  const highGlyphs = sup && high === undefined ? undefined : glyphs(high, superscript);
  if (lowGlyphs !== undefined && highGlyphs !== undefined) {
    return join([base, text(lowGlyphs + highGlyphs)]);
  }
  if (!display) {
    return join([base, text((lowGlyphs ?? '_(' + low + ')') + (highGlyphs ?? '^(' + high + ')'))]);
  }
  const width = Math.max(sub?.width ?? 0, sup?.width ?? 0);
  return join([base, box([
    ...(sup?.lines ?? []).map(line => pad(line, width)),
    ' '.repeat(width),
    ...(sub?.lines ?? []).map(line => pad(line, width)),
  ], sup?.lines.length ?? 0)]);
}

function matrixTable(node, display, budget, depth, opening) {
  const attributes = node.attributes;
  const environment = /^\\begin\{([^}]+)\}/.exec(attributes.get('data-latex') ?? '')?.[1];
  const ruled = ['rowlines', 'columnlines', 'frame'].some(name =>
    String(attributes.get(name) ?? 'none').trim().split(/\s+/).some(rule => rule && rule !== 'none'));
  const sourceRows = node.childNodes;
  if (ruled || (environment && !/^(?:[pbBvV]?matrix|smallmatrix|array)$/.test(environment)) ||
      !sourceRows.length || sourceRows.length > MAX_ROWS) throw new Error('Unsupported matrix layout');
  const rows = sourceRows.map(row => {
    if (row.kind !== 'mtr' || row.childNodes.length > 32) throw new Error('Unsupported matrix row');
    return row.childNodes.map(cell => {
      if (cell.kind !== 'mtd' || Number(cell.attributes.get('rowspan')) > 1 ||
          Number(cell.attributes.get('columnspan')) > 1) throw new Error('Unsupported matrix cell');
      return renderNode(cell, display, budget, depth + 1);
    });
  });
  const columns = Math.max(...rows.map(row => row.length));
  if (!columns) throw new Error('Empty matrix');
  const fence = matrixFences.get(opening);
  if (!display) {
    const values = rows.map(row =>
      Array.from({ length: columns }, (_, column) => row[column]?.lines[0].trim() ?? '').join(', ')).join('; ');
    return text((opening ?? '[') + values + (fence?.close ?? ']'));
  }

  const widths = Array.from({ length: columns }, (_, i) => Math.max(1, ...rows.map(row => row[i]?.width ?? 0)));
  const alignments = (attributes.get('columnalign') ?? 'center').trim().split(/\s+/);
  const lines = rows.flatMap(row => join(widths.flatMap((width, column) => {
    const cell = row[column] ?? text('');
    const align = alignments[Math.min(column, alignments.length - 1)];
    const fit = line => align === 'left' ? pad(line, width)
      : align === 'right' ? ' '.repeat(width - stringWidth(line)) + line : center(line, width);
    const fitted = box(cell.lines.map(fit), cell.baseline);
    return column ? [text('  '), fitted] : [fitted];
  })).lines);
  const baseline = Math.floor((lines.length - 1) / 2);
  if (!fence) return box(lines, baseline);
  if (lines.length === 1) return text(opening + lines[0].trimEnd() + fence.close);
  return box(lines.map((line, i) => {
    const part = i === 0 ? 0 : i === lines.length - 1 ? 2 : 1;
    const middle = part === 1 && i === baseline ? fence.middle : undefined;
    const left = middle?.[0] ?? fence.left[part];
    const right = middle?.[1] ?? fence.right[part];
    return left + ' ' + line + ' ' + right;
  }), baseline);
}

function renderNode(node, display, budget, depth = 0) {
  if (!node || depth > 24 || ++budget.nodes > 512) throw new Error('Terminal math expression is too large');
  const children = node.childNodes;
  const child = index => renderNode(children[index], display, budget, depth + 1);
  if (supportedContainers.has(node.kind)) {
    const parts = [];
    for (let i = 0; i < children.length; i++) {
      const item = children[i];
      const previous = children[i - 1];
      const next = children[i + 1];
      const opening = fenceText(item);
      const closing = matrixFences.get(opening)?.close;
      if (closing && next?.kind === 'mtable' && fenceText(children[i + 2]) === closing) {
        parts.push(matrixTable(next, display, budget, depth + 1, opening));
        i += 2;
        continue;
      }
      // One-sided fences belong to other constructs such as cases. Preserve
      // their TeX until a renderer can reproduce the grouping.
      if (item.kind === 'mtable' && (isFence(previous) || isFence(next))) {
        throw new Error('Unsupported table delimiters');
      }
      const part = child(i);
      if (item.kind !== 'mo') {
        parts.push(part);
        continue;
      }
      const klass = item.texClass;
      const sign = part.lines[0];
      const unary = (sign === '−' || sign === '+') &&
        (!previous || [TEXCLASS.BIN, TEXCLASS.REL, TEXCLASS.OPEN, TEXCLASS.PUNCT].includes(previous.texClass));
      if (klass === TEXCLASS.REL || (klass === TEXCLASS.BIN && !unary)) {
        parts.push(text((previous ? ' ' : '') + sign + (next ? ' ' : '')));
      } else if (next && next.kind !== 'mspace' && next.texClass !== TEXCLASS.CLOSE &&
          (klass === TEXCLASS.PUNCT || (klass === TEXCLASS.OP && /^\p{L}{2,}$/u.test(sign)))) {
        parts.push(text(sign + ' '));
      } else {
        parts.push(part);
      }
    }
    return join(parts);
  }
  switch (node.kind) {
    case 'mtable': return matrixTable(node, display, budget, depth);
    case 'mi': case 'mn': case 'mo': case 'mtext': {
      let value = node.getText().replace(/[\u2061-\u2064]/g, '').replace(/\s+/g, ' ');
      if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
        throw new Error('Unsupported control character');
      }
      const variant = node.attributes.get('mathvariant');
      if (variant === 'double-struck' && Object.hasOwn(blackboard, value)) value = blackboard[value];
      else if (variant && variant !== 'normal' && variant !== 'italic') throw new Error('Unsupported math variant');
      return text(value);
    }
    case 'mspace': {
      const width = node.attributes.get('width') ?? '0';
      const size = Number.parseFloat(width);
      return text(' '.repeat(Number.isFinite(size) ? Math.min(12, Math.max(0, Math.round(size * 2))) : 0));
    }
    case 'mfrac': {
      const top = child(0);
      const bottom = child(1);
      const thickness = node.attributes.get('linethickness');
      const withoutBar = thickness === 0 || /^0(?:[a-z%]+)?$/i.test(thickness);
      if (!top.width || !bottom.width || (!display && withoutBar)) throw new Error('Unsupported fraction');
      if (!display) return text('(' + group(top.lines[0]) + '/' + group(bottom.lines[0]) + ')');
      const width = Math.max(top.width, bottom.width);
      return stack(top, text((withoutBar ? ' ' : '─').repeat(width)), bottom);
    }
    case 'msup': return scripts(child(0), undefined, child(1), display);
    case 'msub': return scripts(child(0), child(1), undefined, display);
    case 'msubsup': return scripts(child(0), child(1), child(2), display);
    case 'msqrt': {
      const inside = child(0);
      return join([text('√('), inside, text(')')]);
    }
    case 'mroot': {
      const degree = renderNode(children[1], false, budget, depth + 1).lines[0];
      return join([text((glyphs(degree, superscript) ?? '(' + degree + ')') + '√('), child(0), text(')')]);
    }
    case 'munderover': case 'munder': case 'mover': {
      const base = child(0);
      const under = node.kind === 'mover' ? undefined : child(1);
      const over = node.kind === 'munder' ? undefined : child(node.kind === 'mover' ? 1 : 2);
      if (display) return stack(over, base, under);
      if (node.attributes.get('accent') === true || node.attributes.get('accentunder') === true) {
        throw new Error('Display required for math accent');
      }
      return scripts(base, under, over, false);
    }
    default: throw new Error('Unsupported MathML layout: ' + node.kind);
  }
}

export function terminalMath(tex, { display = false, width = MAX_CELLS } = {}) {
  const source = tex?.trim();
  if (!source || source.length > MAX_TEX) return;
  const key = (display ? 'display:' : 'inline:') + source;
  if (!cache.has(key)) {
    let layout;
    try {
      const tree = document.convert(source, { display, end: STATE.CONVERT });
      layout = renderNode(tree, display, { nodes: 0 });
    } catch {
      // An unsupported expression stays in its original LaTeX.
    }
    if (cache.size >= 128) cache.delete(cache.keys().next().value);
    cache.set(key, layout);
  }
  const layout = cache.get(key);
  if (layout && layout.width <= width) {
    const lines = layout.lines.map(line => line.trimEnd());
    if (lines.some(line => line.trim())) return lines;
  }
}
