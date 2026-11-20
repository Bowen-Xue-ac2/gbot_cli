const wordEnd = /^[\p{L}\p{M}\p{N}_.-]*/u;
const queryWords = /^[\p{L}\p{M}\p{N}_.-]+(?: +[\p{L}\p{M}\p{N}_.-]+)*$/u;

export function routeQuery({ text, caret, references = [] }) {
  const before = text.slice(0, caret);
  const start = Math.max(before.lastIndexOf('@'), before.lastIndexOf('/'));
  if (start < 0 || (start > 0 && !/\s/u.test(text[start - 1]))) return null;
  if (references.some(ref => ref.start <= start && start < ref.end)) return null;
  const prefix = before.slice(start + 1);
  if (prefix && !queryWords.test(prefix)) return null;
  return {
    trigger: text[start], prefix, start,
    end: caret + wordEnd.exec(text.slice(caret))[0].length,
  };
}

// The upstream editor supplies text and a UTF-16 caret. Keep only selected
// references outside the edited range. Re-typing a label does not bind its ID.
function moveReferences(references, start, end, delta) {
  const kept = [];
  for (const ref of references) {
    if (ref.end <= start) kept.push(ref);
    else if (ref.start >= end) kept.push({ ...ref, start: ref.start + delta, end: ref.end + delta });
  }
  return kept;
}

export function trackRouteEdit(previous, next) {
  if (!previous.references?.length || next.references || !next.text) return next;
  if (previous.text === next.text) return { ...next, references: previous.references };
  let start = 0;
  const limit = Math.min(previous.caret, next.caret);
  while (start < limit && previous.text[start] === next.text[start]) start++;
  let oldEnd = previous.text.length;
  let newEnd = next.text.length;
  while (oldEnd > start && newEnd > start && previous.text[oldEnd - 1] === next.text[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return { ...next, references: moveReferences(previous.references, start, oldEnd, newEnd - oldEnd) };
}

export function completeRoute(draft, item) {
  const query = routeQuery(draft);
  if (!query || !item) return draft;
  const token = '@' + item.label;
  const tail = draft.text.slice(query.end);
  const space = /^\s/u.test(tail) ? '' : ' ';
  const end = query.start + token.length;
  const references = moveReferences(draft.references ?? [], query.start, query.end, end + space.length - query.end);
  references.push({ start: query.start, end, kind: item.kind, id: item.id, label: item.label });
  references.sort((a, b) => a.start - b.start);
  return {
    text: draft.text.slice(0, query.start) + token + space + tail,
    caret: end + (space.length || (tail.startsWith(' ') ? 1 : 0)), references,
  };
}

export function richTextForDraft({ text, references = [] }) {
  if (!references.length) return undefined;
  const from = text.length - text.trimStart().length;
  const to = text.trimEnd().length;
  const paragraphs = [{ type: 'paragraph', content: [] }];
  function appendText(value) {
    const lines = value.split('\n');
    for (const [index, line] of lines.entries()) {
      if (index) paragraphs.push({ type: 'paragraph', content: [] });
      if (line) paragraphs.at(-1).content.push({ type: 'text', text: line });
    }
  }
  let pos = from;
  let bound = false;
  for (const ref of references) {
    if (ref.start < pos || ref.end > to || text.slice(ref.start, ref.end) !== '@' + ref.label) continue;
    appendText(text.slice(pos, ref.start));
    const isMention = ref.kind === 'agent' || ref.kind === 'channel';
    const attrs = { id: ref.id, label: ref.label };
    paragraphs.at(-1).content.push({
      type: isMention ? 'mention' : 'workflowReference',
      attrs: isMention ? { ...attrs, mentionSuggestionChar: '@' } : { ...attrs, iconId: null, iconUrl: null },
    });
    pos = ref.end;
    bound = true;
  }
  if (!bound) return undefined;
  appendText(text.slice(pos, to));
  return JSON.stringify({ type: 'doc', content: paragraphs });
}
