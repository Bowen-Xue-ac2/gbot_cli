import { upstreamDependency, upstreamUrl } from './upstream.mjs';
import { isDeepStrictEqual } from 'node:util';
import { cardActions, cardText, CardActionError } from './bot-cards.mjs';

const { default: React } = await import(upstreamDependency('react'));
const { handleComposeKey, insertAt } = await import(upstreamUrl('dist/tui/compose.js'));
const { isCtrlKey } = await import(upstreamUrl('dist/tui/keys.js'));

function chooser(card, selection) {
  if (card.kind !== 'question') return cardActions(card);
  const step = card.steps[selection?.step ?? 0];
  const choices = step.options.map(({ label, description }, index) => ({
    name: 'option', index, label: description ? label + ' — ' + description : label,
  }));
  if (card.custom) choices.push({ name: 'custom', label: 'Type your own answer' });
  return choices;
}

function renderCard(card, selection, result, body, canAct) {
  const lines = [];
  if (card.kind === 'question') {
    const step = card.steps[selection?.step ?? 0];
    lines.push('Question · ' + step.prompt);
    if (card.steps.length > 1) lines.push('Step ' + ((selection?.step ?? 0) + 1) + '/' + card.steps.length);
    if (card.help) lines.push(card.help);
    if (card.answer) lines.push('Answer: ' + card.answer);
  } else if (card.kind === 'approval') {
    lines.push('Approval · ' + card.title);
    for (const [name, value] of card.details) lines.push(name + ': ' + value);
    if (!card.reviewable) lines.push('Open Grok Bot to review the full request.');
  } else if (card.kind === 'email') {
    lines.push('Email draft · ' + card.title);
    if (card.from) lines.push('From: ' + card.from);
    for (const [label, list] of [['To', card.to], ['Cc', card.cc], ['Bcc', card.bcc]]) {
      if (list.length) lines.push(label + ': ' + list.join(', '));
    }
    lines.push('', body ?? card.body);
  } else {
    lines.push(card.title);
    if (card.details) lines.push(card.details);
    lines.push('Open Grok Bot to handle this card.');
  }
  if (card.status && card.status !== 'pending') lines.push('Status: ' + card.status);
  if (result && card.status === 'pending') lines.push(result.message);
  if (canAct) {
    if (selection?.confirm) {
      lines.push(selection.confirm === 'send' ? 'Press y to send this email · Esc cancels'
        : 'Press y to discard this draft · Esc cancels');
    } else {
      const picked = selection?.picks?.[selection.step] ?? [];
      for (const [index, option] of chooser(card, selection).entries()) {
        const cursor = selection?.index === index ? '› ' : '  ';
        const checked = picked.includes(option.index) ? ' [x]' : '';
        lines.push(cursor + '[' + option.label + ']' + checked);
      }
      if (!selection) lines.push('Tab focuses this card');
    }
  }
  return ['┌─ ' + lines[0], ...lines.slice(1).join('\n').split('\n').map(line => '│ ' + line), '└─'].join('\n');
}

export function useInlineCards({ agentId, client, turns }) {
  const [focus, setFocus] = React.useState(null);
  const [results, setResults] = React.useState(new Map());
  const [edits, setEdits] = React.useState(new Map());
  const resultRef = React.useRef(results);
  const byId = React.useMemo(() => new Map(turns.filter(turn => turn.card).map(turn => [turn.card.entryId, turn.card])), [turns]);
  const card = focus?.agentId === agentId ? byId.get(focus.card.entryId) : undefined;
  const selected = card && isDeepStrictEqual(card, focus.card) && actionable(card) ? focus : null;
  const editor = selected?.editor;

  function actionable(item) {
    return typeof client.actOnCard === 'function' && cardActions(item).length > 0 &&
      !resultRef.current.get(item.entryId)?.locked;
  }
  function editFor(item) {
    const edit = edits.get(item.entryId);
    return edit && isDeepStrictEqual(item, edit.card) ? edit.body : undefined;
  }
  function result(item, next) {
    const map = new Map(resultRef.current);
    map.set(item.entryId, next);
    resultRef.current = map;
    setResults(map);
  }
  function submit(item, input) {
    if (!actionable(item)) return;
    result(item, { locked: true, message: 'Submitting…' });
    setFocus(null);
    void Promise.resolve().then(() => client.actOnCard(agentId, item, input)).then(() => {
      result(item, { locked: true, message: 'Submitted · waiting for Grok Bot to update this card' });
    }).catch(error => {
      result(item, { locked: error?.uncertain === true, message: error instanceof CardActionError
        ? error.message : 'Could not submit the card. Check your Grok Bot session.' });
    });
  }
  function start(item) {
    setFocus(item ? {
      agentId, card: item, step: 0, index: item.kind === 'question' ? 0 : -1,
      picks: item.steps?.map(() => []),
    } : null);
  }
  function answer(picks, custom) {
    if (selected.step + 1 < card.steps.length) {
      setFocus({ ...selected, index: 0, step: selected.step + 1, picks });
    } else {
      submit(card, { name: 'answer', picks, custom });
    }
  }
  function editInput(input, key, width) {
    if (key.escape) {
      setFocus({ ...selected, editor: undefined });
      return;
    }
    if (isCtrlKey(input, key, 's') || (editor.kind === 'custom' && key.return && !key.shift)) {
      if (editor.kind === 'body') {
        setEdits(current => new Map(current).set(card.entryId, { card, body: editor.draft.text }));
        setFocus({ ...selected, editor: undefined });
      } else if (editor.draft.text.trim()) {
        answer(selected.picks, editor.draft.text);
      }
      return;
    }
    const cmd = handleComposeKey(key, editor.draft, width, input);
    let next = cmd.type === 'set' ? cmd.draft : undefined;
    if (cmd.type === 'send' && editor.kind === 'body') next = insertAt(editor.draft.text, editor.draft.caret, '\n');
    if (cmd.type === 'unhandled' && !key.ctrl && !key.meta && !key.super) {
      const text = cardText(input);
      if (text && !/^\s*[\u0000-\u001f]$/.test(text)) next = insertAt(editor.draft.text, editor.draft.caret, text);
    }
    if (next) setFocus({ ...selected, editor: { ...editor, draft: next } });
  }
  function handleInput(input, key, visibleRows, width) {
    if (isCtrlKey(input, key, 'b') || key.pageUp || key.pageDown ||
        isCtrlKey(input, key, 'u') || isCtrlKey(input, key, 'd')) return false;
    if (editor) {
      editInput(input, key, width);
      return true;
    }
    if (key.tab) {
      const ids = [...new Set(visibleRows.map(row => row.cardId).filter(Boolean))].reverse();
      const available = ids.map(id => byId.get(id)).filter(item => item && actionable(item));
      if (!selected && !available.length) return false;
      const current = available.findIndex(item => item.entryId === card?.entryId);
      start(available[current + 1]);
      return true;
    }
    if (!selected) return false;
    if (key.escape) {
      if (selected.confirm) setFocus({ ...selected, confirm: undefined });
      else setFocus(null);
      return true;
    }
    if (selected.confirm) {
      if (input.toLowerCase() === 'y' && !key.ctrl && !key.meta && !key.super) {
        submit(card, { name: selected.confirm, body: editFor(card) });
      }
      return true;
    }
    const options = chooser(card, selected);
    if (key.upArrow || key.downArrow) {
      const direction = key.upArrow ? -1 : 1;
      const base = selected.index < 0 && key.upArrow ? 0 : selected.index;
      setFocus({ ...selected, index: (base + direction + options.length) % options.length });
      return true;
    }
    const action = options[selected.index];
    const step = card.steps?.[selected.step];
    if (input === ' ' && step?.multi && action?.name === 'option') {
      const picks = [...selected.picks];
      const current = picks[selected.step];
      picks[selected.step] = current.includes(action.index)
        ? current.filter(index => index !== action.index) : [...current, action.index];
      setFocus({ ...selected, picks });
      return true;
    }
    if (!key.return || key.shift || !action) return true;
    if (action.name === 'option') {
      const picks = [...selected.picks];
      if (!step.multi) picks[selected.step] = [action.index];
      if (picks[selected.step].length) answer(picks);
    } else if (action.name === 'custom' || action.name === 'edit') {
      const isBody = action.name === 'edit';
      const text = isBody ? editFor(card) ?? card.body : '';
      setFocus({ ...selected, editor: { kind: isBody ? 'body' : 'custom', draft: { text, caret: text.length } } });
    } else if (action.name === 'send' || action.name === 'discard') {
      setFocus({ ...selected, confirm: action.name });
    } else {
      submit(card, { name: action.name });
    }
    return true;
  }

  const rendered = React.useMemo(() => turns.map(turn => turn.card ? {
    ...turn,
    text: renderCard(turn.card, turn.card.entryId === selected?.card.entryId ? selected : null,
      results.get(turn.card.entryId), editFor(turn.card), actionable(turn.card)),
  } : turn), [turns, selected, results, edits, client]);
  const hint = editor ? (editor.kind === 'body' ? 'Ctrl+S save body · Esc cancel edit' : 'Enter submit answer · Esc cancel')
    : selected ? '↑↓ select · Space toggles · Enter choose · Tab next · Esc chat' : undefined;
  return { rendered, focused: Boolean(selected), editor: editor?.draft, handleInput, hint };
}
