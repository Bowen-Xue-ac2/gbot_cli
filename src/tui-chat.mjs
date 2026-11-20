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
const browserUrl = new URL('./browser-links.mjs', import.meta.url).href;
const catalogUrl = new URL('./route-catalog.mjs', import.meta.url).href;
const senderUrl = new URL('./backend-send.mjs', import.meta.url).href;
const pickerUrl = new URL('./route-picker.mjs', import.meta.url).href;
const draftUrl = new URL('./route-draft.mjs', import.meta.url).href;

export function patchCardHost(source) {
  const method = '    async sendPrompt(input) {';
  return 'import { submitCardAction } from ' + JSON.stringify(protocolUrl) + ';\n' +
    'import { skillRoutes } from ' + JSON.stringify(catalogUrl) + ';\n' +
    'import { listConnectedApps } from ' + JSON.stringify(senderUrl) + ';\n' +
    replaceOnce(source, method, '    actOnCard(agentId, card, action) {\n' +
      '        return submitCardAction((method, body, signal) => this.#call(method, body, signal), agentId, card, action);\n' +
      '    }\n    async listRouteSkills(agentId, signal) {\n' +
      '        return skillRoutes(await this.#call("getAgentWorkflows", { id: agentId }, signal));\n' +
      '    }\n    listRouteApps(agentId, signal) {\n' +
      '        return listConnectedApps(agentId, signal);\n' +
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
  source = replaceOnce(source, 'wait: !isGroup,', 'wait: false,\n                ...(richText ? { richText } : {}),');
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
    ['Box, Text, useApp, useInput, useStdout, useWindowSize', 'Box, Text, measureElement, useApp, useInput, useStdout, useWindowSize'],
    ['function renderTranscriptRows(rows, inner)', 'function renderTranscriptRows(rows, inner, linkRows)'],
    ['const agentId = agent.id;', [
      'const agentId = agent.id;',
      '    const cards = useInlineCards({ agentId, client, turns });',
      '    const [showSource, setShowSource] = useState(false);',
      '    const [browserError, setBrowserError] = useState(false);',
      '    const linkRows = useRef(new Map());',
      '    const linkPress = useRef(null);',
      '    const transcript = useRef(null);',
    ].join('\n')],
    ['const [draft, setDraft] = useState(EMPTY_DRAFT);', 'const [draft, setDraft] = useRouteDraft(EMPTY_DRAFT);'],
    ['const prompt = text.trim();', 'const prompt = text.trim();\n        const richText = richTextForDraft(draftRef.current);'],
    ['const mentionOptions = useMemo(() => (isGroup ? mentionNames(liveAgent, liveRoster) : []), [isGroup, liveAgent, liveRoster]);',
      'const picker = useRoutePicker({ draft, agent: liveAgent, roster: liveRoster, client, enabled: !cards.focused && status.kind !== "sending" && status.kind !== "loading" });'],
    ['const mentionQ = isGroup ? mentionQuery(draft.text, draft.caret) : null;', 'const mentionQ = picker.query;'],
    ['const mentionMatches = mentionQ ? filterMentions(mentionOptions, mentionQ.prefix) : [];', 'const mentionMatches = picker.matches;'],
    ['`${mentionQ.start}:${mentionQ.prefix}`', '`${mentionQ.start}:${mentionQ.trigger}:${mentionQ.prefix}`'],
    ['mentionMenuOpen(mentionMatches.length, mentionDismissed)', 'Boolean(mentionQ) && !mentionDismissed'],
    ['const mentionShown = menuOpen ? visibleMentions(mentionMatches, mentionIndex) : [];',
      'const selectedRoute = mentionMatches[Math.min(mentionIndex, mentionMatches.length - 1)];\n' +
      '    const mentionShown = menuOpen ? visibleMentions(mentionMatches, mentionIndex, Math.max(1, Math.min(MAX_VISIBLE_MENTIONS, (rows || 24) - 10))) : [];'],
    ['Math.min(mentionMatches.length, MAX_VISIBLE_MENTIONS)', 'mentionShown.length'],
    ['const pick = mentionMatches.length === 1 ? mentionMatches[0] : mentionMatches[mentionIndex] ?? mentionMatches[0];',
      'const pick = selectedRoute;'],
    ['completeMention(value.text, pick, value.caret)', 'completeRoute(value, pick)'],
    ['const selected = name === mentionMatches[mentionIndex];', 'const selected = name === selectedRoute;'],
    ['children: [selected ? "› @" : "  @", name] }, name)',
      'children: [selected ? "› " : "  ", mentionQ.trigger, name.label, "  [", name.detail, "]"] }, name.kind + ":" + name.id)'],
    ['const composeLaid = layoutCompose(draft.text, draft.caret, inner);',
      'const activeDraft = cards.editor ?? draft;\n    const composeLaid = layoutCompose(activeDraft.text, activeDraft.caret, inner);'],
    ['turnsToRows(turns, inner, labelCtx), [turns, inner, labelCtx]',
      'turnsToRows(cards.rendered, inner, labelCtx, { source: showSource }), [cards.rendered, inner, labelCtx, showSource]'],
    ['const current = statusRef.current;',
      'const current = statusRef.current;\n        if (!cards.focused && isCtrlKey(input, key, "r")) { setShowSource(value => !value); return; }'],
    ['                if (event.release)\n                    continue;', [
      '                if (event.button === 0) {',
      '                    const { x, y } = event;',
      '                    const href = linkAtPoint(linkRows.current, transcript.current, x - 1, y - 1, measureElement);',
      '                    if (!event.release) {',
      '                        linkPress.current = href ? { href, x, y } : null;',
      '                    } else {',
      '                        const press = linkPress.current;',
      '                        linkPress.current = null;',
      '                        if (press && href === press.href && x === press.x && y === press.y) {',
      '                            setBrowserError(false);',
      '                            openBrowserLink(href).catch(() => setBrowserError(true));',
      '                        }',
      '                    }',
      '                }',
      '                if (event.release)',
      '                    continue;',
    ].join('\n')],
    ['        if (menuOpen) {',
      '        if ((cards.focused || !menuOpen) && cards.handleInput(input, key, view.rows, inner)) return;\n        if (menuOpen) {'],
    ['const canType = status.kind !== "sending" && status.kind !== "loading";',
      'const canType = Boolean(cards.editor) || (!cards.focused && status.kind !== "sending" && status.kind !== "loading");'],
    ['const composePlaceholder = draft.text.length === 0 ? (busy ? "waiting…" : "message") : null;',
      'const composePlaceholder = activeDraft.text.length === 0 ? (cards.editor ? "card input" : busy ? "waiting…" : "message") : null;'],
    ['children: FOOTER_HINT', 'children: browserError ? "Could not open the default browser." : cards.hint ?? (menuOpen ? [picker.note, mentionMatches.length ? "↑↓ select · Tab/Enter insert" : "", "Esc close"].filter(Boolean).join(" · ") : "@ agent/app · / skill · " + (showSource ? "Ctrl+R reader" : "Ctrl+R source") + " · " + FOOTER_HINT)'],
    ['justifyContent: TRANSCRIPT_JUSTIFY', 'ref: transcript, justifyContent: TRANSCRIPT_JUSTIFY'],
    ['renderTranscriptRows(view.rows, inner)', 'renderTranscriptRows(view.rows, inner, linkRows.current)'],
    ['const color = isUser', 'const color = row.cardId ? "yellow" : isUser'],
    ['out.push(_jsx(Text, { bold: row.kind === "speaker", dimColor: row.kind === "image", color: color, wrap: "truncate", children: row.text }, `${row.kind}-${i}-${row.text.trimStart().slice(0, 16)}`));', [
      'const key = row.kind + "-" + i + "-" + row.text.trimStart().slice(0, 16);',
      '        const text = _jsx(Text, { bold: row.kind === "speaker", dimColor: row.kind === "image", color, wrap: "truncate",',
      '            children: row.spans && row.text ? row.spans.map((span, index) => _jsx(Text, { ...span.style, children: span.text }, index)) : row.text || " " }, key);',
      '        if (row.spans?.some(span => span.href)) {',
      '            out.push(_jsx(Box, { ref: node => {',
      '                if (node) linkRows.set(i, { node, spans: row.spans });',
      '                else linkRows.delete(i);',
      '            }, children: text }, key));',
      '        } else {',
      '            out.push(text);',
      '        }',
    ].join('\n')],
  ];
  for (const [before, after] of replacements) source = replaceOnce(source, before, after);
  return 'import { useInlineCards } from ' + JSON.stringify(inlineUrl) + ';\n' +
    'import { linkAtPoint, openBrowserLink } from ' + JSON.stringify(browserUrl) + ';\n' +
    'import { useRouteDraft, useRoutePicker } from ' + JSON.stringify(pickerUrl) + ';\n' +
    'import { completeRoute, richTextForDraft } from ' + JSON.stringify(draftUrl) + ';\n' + source;
}
