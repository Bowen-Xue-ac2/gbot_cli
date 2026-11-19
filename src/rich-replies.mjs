import { renderMermaidASCII } from 'beautiful-mermaid';
import stringWidth from 'string-width';

const MAX_BLOCK = 4096;
const cache = new Map();
const controlChar = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

export function renderMermaidLines(source, width) {
  if (source.length > MAX_BLOCK || controlChar.test(source) || source.split(/[\n;]/).length > 70 ||
      !/^(?:flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram|xychart(?:-beta)?)\b/.test(source.trim())) {
    return;
  }
  if (!cache.has(source)) {
    let lines;
    try {
      const rendered = renderMermaidASCII(source).trimEnd();
      const rows = rendered.split('\n');
      if (rendered.trim() && rows.length <= 60) lines = rows;
    } catch {
      // Keep the Markdown source when Mermaid cannot produce a diagram.
    }
    if (cache.size >= 48) cache.delete(cache.keys().next().value);
    cache.set(source, lines);
  }
  const lines = cache.get(source);
  return lines?.every(line => stringWidth(line) <= width) ? lines : undefined;
}
