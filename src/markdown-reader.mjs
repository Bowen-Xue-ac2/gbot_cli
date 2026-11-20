import MarkdownIt from 'markdown-it';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';
import { renderMermaidLines } from './rich-replies.mjs';
import { terminalMath } from './terminal-math.mjs';
import { browserUrl } from './browser-links.mjs';

const MAX_MARKDOWN = 64 * 1024;
const md = new MarkdownIt({ html: false, breaks: true, linkify: true });
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const subtle = { dimColor: true };
const codeStyle = { color: 'cyan' };
const mathStyle = { color: 'yellow' };
const headingStyle = { bold: true, color: 'cyan' };
const linkStyle = { color: 'cyan', underline: true };
const unsafeControls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;
const wrapCache = new Map();

function escapedAt(text, index) {
  let first = index;
  while (first > 0 && text[first - 1] === '\\') first--;
  return (index - first) % 2 === 1;
}

function inlineLatex(state, silent) {
  const { src, pos, posMax } = state;
  const parens = src.startsWith('\\(', pos);
  if (!parens && (src[pos] !== '$' || !src[pos + 1] || /[$\s]/.test(src[pos + 1]))) return false;
  if (escapedAt(src, pos) || (!parens && pos > 0 && src[pos - 1] === '$')) return false;
  const open = parens ? 2 : 1;
  const close = parens ? '\\)' : '$';
  let end = src.indexOf(close, pos + open);
  while (end >= 0 && end - pos <= 4096 && escapedAt(src, end)) end = src.indexOf(close, end + close.length);
  if (end <= pos + open || end + close.length > posMax || end - pos > 4096) return false;
  const body = src.slice(pos + open, end);
  if (body.includes('\n') || (!parens && (/\s$/.test(body) || /[$\d]/.test(src[end + 1] ?? '')))) return false;
  if (!silent) {
    const token = state.push('gbot_latex_inline', '', 0);
    token.content = src.slice(pos, end + close.length);
    token.meta = { tex: body };
  }
  state.pos = end + close.length;
  return true;
}

function blockLatex(state, start, end, silent) {
  if (state.sCount[start] - state.blkIndent >= 4) return false;
  const lineText = line => state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
  const line = lineText(start);
  const head = line.startsWith('$$') ? '$$' : line.startsWith('\\[') ? '\\[' : undefined;
  if (!head || (head === '$$' && line.startsWith('$$$'))) return false;
  if (silent) return true;
  const tail = head === '$$' ? '$$' : '\\]';
  const closes = value => {
    const trimmed = value.trimEnd();
    return trimmed.endsWith(tail) && !escapedAt(trimmed, trimmed.length - tail.length);
  };
  let next = start + 1;
  let closed = closes(line.slice(head.length));
  while (!closed && next < end) {
    if (!state.isEmpty(next) && state.sCount[next] < state.blkIndent) break;
    closed = closes(lineText(next++));
  }
  const token = state.push('gbot_latex_block', '', 0);
  token.map = [start, next];
  token.content = state.getLines(start, next, state.blkIndent, false);
  if (closed) token.meta = { tex: token.content.trim().slice(head.length, -tail.length) };
  state.line = next;
  return true;
}

md.inline.ruler.before('escape', 'gbot_latex', inlineLatex);
md.block.ruler.before('fence', 'gbot_latex', blockLatex, { alt: ['paragraph', 'blockquote', 'list'] });

function safeText(text) {
  return stripVTControlCharacters(text.replace(/\r\n?/g, '\n')).replace(unsafeControls, '�');
}

function addSpan(row, text, style, href) {
  if (!text) return;
  const last = row.at(-1);
  if (last && last.style === style && last.href === href) last.text += text;
  else row.push(href ? { text, style, href } : { text, style });
}

const flatten = spans => spans.map(span => span.text).join('');

function literalLines(text, width, style) {
  const rows = [];
  for (const line of text.split('\n')) {
    const expanded = line.replace(/\t/g, '    ');
    if (stringWidth(expanded) <= width) {
      rows.push([{ text: expanded, style }]);
      continue;
    }
    let buffer = '';
    let cells = 0;
    for (const { segment } of segmenter.segment(expanded)) {
      const size = stringWidth(segment);
      if (cells + size > width && buffer) {
        rows.push([{ text: buffer, style }]);
        buffer = '';
        cells = 0;
      }
      buffer += segment;
      cells += size;
    }
    rows.push([{ text: buffer, style }]);
  }
  return rows;
}

function wrapSpans(spans, width) {
  const rows = [];
  let row = [];
  let cells = 0;
  const nextLine = () => {
    while (row.length && !row.at(-1).text.trim()) row.pop();
    if (row.length) row.at(-1).text = row.at(-1).text.trimEnd();
    rows.push(row);
    row = [];
    cells = 0;
  };
  for (const { text, style, href } of spans) {
    for (const word of text.match(/\n|[ \t]+|[^\n\t ]+/g) ?? []) {
      if (word === '\n') {
        nextLine();
        continue;
      }
      const blank = !word.trim();
      const chunk = word.replace(/\t/g, '    ');
      const size = stringWidth(chunk);
      if (blank && (cells === 0 || cells + size > width)) continue;
      if (cells && size <= width && cells + size > width) nextLine();
      if (size <= width) {
        addSpan(row, chunk, style, href);
        cells += size;
        continue;
      }
      for (const { segment } of segmenter.segment(chunk)) {
        const segmentWidth = stringWidth(segment);
        if (cells && cells + segmentWidth > width) nextLine();
        addSpan(row, segment, style, href);
        cells += segmentWidth;
      }
    }
  }
  nextLine();
  return rows;
}

function inlineSpans(tokens, base) {
  const levels = [base];
  const out = [];
  const inlineStyles = {
    strong_open: { bold: true }, em_open: { italic: true }, s_open: { strikethrough: true },
  };
  let href;
  for (const token of tokens) {
    const style = levels.at(-1);
    if (token.type === 'link_open') {
      href = browserUrl(token.attrGet('href'));
      levels.push(href ? { ...style, ...linkStyle } : style);
    } else if (token.nesting === -1 && levels.length > 1) {
      levels.pop();
      if (token.type === 'link_close') href = undefined;
    } else if (Object.hasOwn(inlineStyles, token.type)) levels.push({ ...style, ...inlineStyles[token.type] });
    else if (token.type === 'code_inline') addSpan(out, token.content, { ...style, ...codeStyle }, href);
    else if (token.type === 'gbot_latex_inline') {
      addSpan(out, terminalMath(token.meta?.tex)?.[0] ?? token.content, { ...style, ...mathStyle }, href);
    }
    else if (token.type === 'softbreak' || token.type === 'hardbreak') addSpan(out, '\n', style, href);
    else if (token.type === 'image') addSpan(out, token.content ? '[image: ' + token.content + ']' : '[image]', subtle, href);
    else if (token.content) addSpan(out, token.content, style, href);
  }
  return out;
}

function mathRows(tex, source, width) {
  const display = terminalMath(tex, { display: true, width });
  if (display) return display.map(text => [{ text, style: mathStyle }]);
  const linear = terminalMath(tex)?.[0];
  if (linear) return wrapSpans([{ text: linear, style: mathStyle }], width);
  return literalLines(source, width, mathStyle);
}

function tableRows(matrix, width) {
  if (!matrix.length || !matrix[0].length) return [];
  const [header, ...records] = matrix;
  const columns = header.length;
  const budget = width - (columns * 3 + 1);
  if (budget < columns * 3) {
    if (!records.length) return wrapSpans(header.flatMap(cell => [...cell, { text: '  ' }]), width);
    return records.flatMap((record, index) => [
      ...(index ? [[]] : []),
      ...header.flatMap((cell, col) => wrapSpans([
        { text: flatten(cell) + ': ', style: { bold: true } }, ...(record[col] ?? []),
      ], width)),
    ]);
  }

  const sizes = header.map((_, col) => Math.max(3, ...matrix.map(row =>
    Math.min(budget, stringWidth(flatten(row[col] ?? []))))));
  let total = sizes.reduce((sum, size) => sum + size, 0);
  while (total > budget) {
    const col = sizes.indexOf(Math.max(...sizes));
    sizes[col]--;
    total--;
  }
  const border = (left, join, right) => [{
    text: left + sizes.map(size => '─'.repeat(size + 2)).join(join) + right,
    style: subtle,
  }];
  const output = [border('┌', '┬', '┐')];
  for (const [index, record] of matrix.entries()) {
    if (index) output.push(border('├', '┼', '┤'));
    const row = sizes.map((size, col) => wrapSpans(record[col] ?? [], size));
    const height = Math.max(...row.map(cell => cell.length));
    for (let line = 0; line < height; line++) {
      const spans = [{ text: '│', style: subtle }];
      for (const [col, size] of sizes.entries()) {
        const content = row[col][line] ?? [];
        spans.push({ text: ' ' }, ...content, { text: ' '.repeat(Math.max(0, size - stringWidth(flatten(content)) + 1)) + '│', style: subtle });
      }
      output.push(spans);
    }
  }
  output.push(border('└', '┴', '┘'));
  return output;
}

function hasClosingFence(token, lines) {
  const [start, end] = token.map ?? [];
  if (end - start < 2) return false;
  const line = lines[end - 1]?.trim().replace(/^(?:>\s*)+/, '') ?? '';
  return line.length >= token.markup.length && [...line].every(char => char === token.markup[0]);
}

const displayRows = lines => lines.map(spans => ({ text: flatten(spans), spans }));

export function markdownRows(text, width, { source = false } = {}) {
  text = safeText(text);
  if (source || text.length > MAX_MARKDOWN) return displayRows(literalLines(text, width));
  // Width and source form the viewport representation. Polling can send the
  // same content many times, so reuse layout for unchanged messages.
  const cached = wrapCache.get(text);
  if (cached?.width === width) return cached.rows;

  const tokens = md.parse(text, {});
  const lines = text.split('\n');
  const output = [];
  const lists = [];
  let quoteDepth = 0;
  let heading = false;
  let lastLine = 0;
  function gap() {
    if (output.length && output.at(-1).length) output.push([]);
  }
  function append(token, makeRows, marker = undefined) {
    const item = lists.at(-1);
    const prefixLimit = Math.max(0, width - 6);
    const indent = ('│ '.repeat(quoteDepth) + '  '.repeat(Math.max(0, lists.length - 1))).slice(0, prefixLimit);
    const label = marker ?? item?.marker ?? '';
    const continuation = indent + ' '.repeat(label.length);
    const first = item?.fresh ? indent + label : continuation;
    if (item) item.fresh = false;
    if (token.map?.[0] > lastLine && !lists.length && !quoteDepth) gap();
    const room = Math.max(1, width - stringWidth(continuation));
    for (const [index, spans] of makeRows(room).entries()) {
      const prefix = index === 0 ? first : continuation;
      output.push(prefix ? [{ text: prefix, style: subtle }, ...spans] : spans);
    }
    lastLine = token.map?.[1] ?? lastLine;
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'heading_open': heading = true; gap(); break;
      case 'heading_close': heading = false; break;
      case 'blockquote_open': quoteDepth++; break;
      case 'blockquote_close': quoteDepth--; break;
      case 'bullet_list_open': lists.push({}); break;
      case 'ordered_list_open': lists.push({ number: Number(token.attrGet('start') ?? 1) }); break;
      case 'bullet_list_close':
      case 'ordered_list_close': lists.pop(); break;
      case 'list_item_open': {
        const item = lists.at(-1);
        item.marker = item.number == null ? '• ' : String(item.number++) + '. ';
        item.fresh = true;
        break;
      }
      case 'inline': {
        const spans = inlineSpans(token.children ?? [], heading ? headingStyle : undefined);
        const task = lists.at(-1)?.fresh && /^\[([ xX])\]\s+/.exec(spans[0]?.text ?? '');
        if (task) spans[0].text = spans[0].text.slice(task[0].length);
        append(token, room => wrapSpans(spans, room), task ? (task[1] === ' ' ? '□ ' : '✓ ') : undefined);
        break;
      }
      case 'gbot_latex_block': append(token, room => mathRows(token.meta?.tex, token.content, room)); break;
      case 'fence': {
        const language = token.info.trim().split(/\s+/)[0]?.toLowerCase();
        const content = token.content.replace(/\n$/, '');
        append(token, room => {
          if (language === 'mermaid') {
            const diagram = hasClosingFence(token, lines) && renderMermaidLines(content, room);
            if (diagram) return diagram.map(line => [{ text: line, style: codeStyle }]);
            return literalLines(lines.slice(...token.map).join('\n'), room, codeStyle);
          }
          if (language === 'latex' || language === 'math') {
            const raw = lines.slice(...token.map).join('\n');
            return mathRows(hasClosingFence(token, lines) ? content : undefined, raw, room);
          }
          return literalLines(content, room, codeStyle);
        });
        break;
      }
      case 'code_block': append(token, room => literalLines(token.content.replace(/\n$/, ''), room, codeStyle)); break;
      case 'hr': append(token, room => [[{ text: '─'.repeat(Math.min(room, 30)), style: subtle }]]); break;
      case 'table_open': {
        const matrix = [];
        while (++i < tokens.length && tokens[i].type !== 'table_close') {
          const cell = tokens[i];
          if (cell.type === 'tr_open') matrix.push([]);
          if (cell.type === 'inline') matrix.at(-1).push(inlineSpans(cell.children ?? [], matrix.length === 1 ? headingStyle : undefined));
        }
        append(token, room => tableRows(matrix, room));
        break;
      }
    }
  }
  const rows = displayRows(output);
  if (wrapCache.size >= 64) wrapCache.delete(wrapCache.keys().next().value);
  wrapCache.set(text, { width, rows });
  return rows;
}
