import { LauncherError } from './windows-session.mjs';

function replaceOnce(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new LauncherError('chat-adapter', 'The installed TUI chat changed. Review the Windows chat adapter.');
  }
  return source.replace(before, after);
}

const protocolUrl = new URL('./bot-cards.mjs', import.meta.url).href;
const inlineUrl = new URL('./inline-cards.mjs', import.meta.url).href;
const readerUrl = new URL('./markdown-reader.mjs', import.meta.url).href;

export function patchCardHost(source) {
  const method = '    async sendPrompt(input) {';
  return 'import { submitCardAction } from ' + JSON.stringify(protocolUrl) + ';\n' +
    replaceOnce(source, method, '    actOnCard(agentId, card, action) {\n' +
      '        return submitCardAction((method, body, signal) => this.#call(method, body, signal), agentId, card, action);\n' +
      '    }\n' + method);
}

export function patchCardTranscript(source) {
  const point = '        const text = isRecord(entry) ? textFromHostEntry(rec) : undefined;';
  return 'import { parseBotCard } from ' + JSON.stringify(protocolUrl) + ';\n' +
    replaceOnce(source, point, [
      '        const card = parseBotCard(rec);',
      '        if (card) {',
      '            const { speaker, agentId } = speakerFromEntry(rec);',
      '            turns.push({ id: "card-" + card.entryId, role: "assistant", speaker,',
      '                speakerId: agentId, text: card.title, timestampMs: rec.timestampMs, card });',
      '            return;',
      '        }',
      point,
    ].join('\n'));
}

export function patchCardPoll(source) {
  const start = 'function turnSig(turn) {';
  source = replaceOnce(source, start, start + '\n    if (turn.card) return JSON.stringify(turn.card);');
  const key = 'function turnContentKey(turn) {';
  return replaceOnce(source, key, key + '\n    if (turn.card) return "card:" + turn.card.entryId;');
}

export function patchCardLayout(source) {
  source = replaceOnce(source, 'turnsToRows(turns, width, agentNameOrCtx)',
    'turnsToRows(turns, width, agentNameOrCtx, richOptions)');
  source = replaceOnce(source, 'const extracted = imagesFromText(turn.text);', [
    'const readMarkdown = turn.role === "assistant" && !turn.card;',
    '        const extracted = turn.card ? { text: turn.text, images: [] } :',
    '            imagesFromText(turn.text);',
  ].join('\n'));
  source = replaceOnce(source, 'const bodyText = extracted.text;',
    'const bodyText = readMarkdown && (richOptions?.source || !extracted.images.length) ? turn.text : extracted.text;');
  source = replaceOnce(source, 'if (bodyText.trim().length > 0) {',
    'if (readMarkdown && bodyText.trim().length > 0) {\n' +
    '            for (const row of markdownRows(bodyText, bodyWidth, richOptions)) {\n' +
    '                pending.push({ ...row, kind: "body", role: turn.role, align });\n' +
    '            }\n' +
    '        } else if (bodyText.trim().length > 0) {');
  source = replaceOnce(source, 'rows.push(...pending);',
    'rows.push(...(turn.card ? pending.map(row => ({ ...row, cardId: turn.card.entryId })) : pending));');
  return 'import { markdownRows } from ' + JSON.stringify(readerUrl) + ';\n' + source;
}

// Keep the upstream package intact. A send waits only for submission acknowledgement;
// the existing background transcript poll owns all incoming messages, including 1:1.
export function patchTuiChatSource(source) {
  source = replaceOnce(source, 'wait: !isGroup,', 'wait: false,');
  const start = '            // Rooms: keep the optimistic turn until idle poll sees the host commit.';
  const end = '\n        }\n        catch (err) {';
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin);
  if (begin < 0 || finish < 0 || source.indexOf(start, begin + start.length) >= 0) {
    throw new LauncherError('chat-adapter', 'The installed TUI chat changed. Review the reply handling adapter.');
  }
  source = source.slice(0, begin) +
    '            // Keep optimistic turns until background polling sees their host echoes.\n' +
    '            // Release composition after the ACK, without waiting for a bot reply.\n' +
    '            setStatus({ kind: "idle" });' + source.slice(finish);
  source = replaceOnce(source, 'return isGroup ? "sent" : "waiting";', 'return "sending";');
  const replacements = [
    ['const agentId = agent.id;', [
      'const agentId = agent.id;',
      '    const cards = useInlineCards({ agentId, client, turns });',
      '    const [showSource, setShowSource] = useState(false);',
    ].join('\n')],
    ['const menuOpen = mentionMenuOpen(', 'const menuOpen = !cards.focused && mentionMenuOpen('],
    ['const composeLaid = layoutCompose(draft.text, draft.caret, inner);',
      'const activeDraft = cards.editor ?? draft;\n    const composeLaid = layoutCompose(activeDraft.text, activeDraft.caret, inner);'],
    ['turnsToRows(turns, inner, labelCtx), [turns, inner, labelCtx]',
      'turnsToRows(cards.rendered, inner, labelCtx, { source: showSource }), [cards.rendered, inner, labelCtx, showSource]'],
    ['const current = statusRef.current;',
      'const current = statusRef.current;\n        if (!cards.focused && isCtrlKey(input, key, "r")) { setShowSource(value => !value); return; }'],
    ['        if (menuOpen) {',
      '        if ((cards.focused || !menuOpen) && cards.handleInput(input, key, view.rows, inner)) return;\n        if (menuOpen) {'],
    ['const canType = status.kind !== "sending" && status.kind !== "loading";',
      'const canType = Boolean(cards.editor) || (!cards.focused && status.kind !== "sending" && status.kind !== "loading");'],
    ['const composePlaceholder = draft.text.length === 0 ? (busy ? "waiting…" : "message") : null;',
      'const composePlaceholder = activeDraft.text.length === 0 ? (cards.editor ? "card input" : busy ? "waiting…" : "message") : null;'],
    ['children: FOOTER_HINT', 'children: cards.hint ?? ((showSource ? "Ctrl+R reader" : "Ctrl+R source") + " · " + FOOTER_HINT)'],
    ['const color = isUser', 'const color = row.cardId ? "yellow" : isUser'],
    ['color: color, wrap: "truncate", children: row.text }',
      'color: color, wrap: "truncate", children: row.spans && row.text ? row.spans.map((span, index) => _jsx(Text, { ...span.style, children: span.text }, index)) : row.text || " " }'],
  ];
  for (const [before, after] of replacements) source = replaceOnce(source, before, after);
  return 'import { useInlineCards } from ' + JSON.stringify(inlineUrl) + ';\n' + source;
}
