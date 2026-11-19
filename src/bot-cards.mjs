import { isDeepStrictEqual, stripVTControlCharacters } from 'node:util';
import { loadWindowsSendCredentials } from './windows-session.mjs';

const readOnlyKinds = new Set([
  'mission', 'mission-card', 'mission-approval', 'purchase-approval', 'virtual-card-approval',
  'connector-grant', 'user-form', 'secret-request', 'app-secrets-request',
]);
const approvalKinds = new Set(['auto-review-approval', 'local-tool-permission']);
const control = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
const object = value => value != null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && /^[\w.:-]{1,512}$/.test(value);

export function cardText(value) {
  return typeof value === 'string'
    ? stripVTControlCharacters(value.replace(/\r\n?/g, '\n')).replace(control, '�')
    : '';
}

const line = value => cardText(value).replace(/\s+/g, ' ').trim();
const stringValue = value => typeof value === 'string' ? value : object(value) ? JSON.stringify(value) : '';
const addresses = value => (Array.isArray(value) ? value : [value]).map(line).filter(Boolean);
const reviewableAddresses = value => value == null ||
  (Array.isArray(value) ? value : [value]).every(address =>
    typeof address === 'string' && address.trim() === line(address));

function parseStep(step) {
  const options = [];
  for (const option of Array.isArray(step?.options) ? step.options : []) {
    const label = line(typeof option === 'string' ? option : option?.label ?? option?.value);
    const value = typeof option === 'string' ? option : option?.value ?? option?.label;
    if (label && typeof value === 'string' && line(value) && cardText(value) === value.replace(/\r\n?/g, '\n')) {
      options.push({ label, value: line(value), description: line(option?.description) });
    }
  }
  return { prompt: line(step?.prompt), multi: step?.multiSelect === true, options };
}

export function parseBotCard(entry) {
  const message = entry?.message;
  const type = message?.type;
  if (entry?.kind !== 'send-message' || entry.role === 'user' || entry.role === 'system' ||
      entry.fromUser != null || !validId(entry.id)) return;
  const base = { type, entryId: entry.id };
  if (type === 'widget' && object(message.widget)) {
    const widget = message.widget;
    const steps = Array.isArray(widget.steps) && widget.steps.length > 1
      ? widget.steps.map(parseStep) : [parseStep(widget)];
    const custom = steps.length === 1 && widget.allowCustom === true;
    if (steps.some(step => !step.prompt || (!custom && step.options.length === 0))) return;
    const status = typeof entry.respondedValue === 'string' ? 'answered'
      : entry.widgetDismissed || entry.widgetSkipped ? 'dismissed'
        : line(widget.status) || 'pending';
    return { ...base, kind: 'question', title: line(widget.prompt) || steps[0].prompt,
      help: cardText(widget.helpText), steps, custom, status,
      answer: cardText(entry.respondedValue) };
  }
  if (approvalKinds.has(type)) {
    const approval = type === 'local-tool-permission' ? message.ask : message.approval;
    if (!object(approval)) return;
    const summary = approval.summary ?? approval.title ?? approval.description ?? approval.toolName ?? approval.tool;
    const details = ['reason', 'action', 'command', 'input', 'args', 'target', 'workingDirectory', 'machineId', 'surface']
      .map(key => [key, stringValue(approval[key])]).filter(([, value]) => value);
    return { ...base, kind: 'approval', requestId: approval.requestId,
      title: line(summary) || 'Approval requested',
      details: details.map(([key, value]) => [key, cardText(value).slice(0, 2048)]),
      reviewable: Boolean(line(summary) || details.length) && approval.truncated !== true &&
        details.every(([, value]) => value.length <= 2048 && cardText(value) === value.replace(/\r\n?/g, '\n')),
      status: line(approval.status) || 'status unavailable' };
  }
  if (type === 'email-draft' && object(message.draft)) {
    const draft = message.draft;
    const rawStatus = line(entry.draftSendState ?? entry.draftSaveState) || 'editable';
    return { ...base, kind: 'email', title: line(draft.subject) || 'Email draft',
      status: ['editable', 'saved'].includes(rawStatus) ? 'pending' : rawStatus,
      from: line(draft.from), to: addresses(draft.to), cc: addresses(draft.cc), bcc: addresses(draft.bcc),
      body: cardText(draft.body), draft,
      reviewable: [draft.from, draft.to, draft.cc, draft.bcc].every(reviewableAddresses) &&
        typeof draft.body === 'string' && cardText(draft.body) === draft.body.replace(/\r\n?/g, '\n') };
  }
  if (readOnlyKinds.has(type)) {
    const data = Object.values(message).find(object) ?? {};
    return { ...base, kind: 'info', title: line(data.title ?? data.summary ?? message.title) || type,
      details: cardText(data.description ?? data.reason ?? message.description) };
  }
}

export function cardActions(card) {
  if (card.status !== 'pending') return [];
  switch (card.kind) {
    case 'approval':
      if (!validId(card.requestId)) return [];
      return [...(card.reviewable ? [{ name: 'approve', label: 'Allow once' }] : []),
        { name: 'deny', label: 'Reject' }];
    case 'email':
      return [...(card.to.length && card.reviewable
        ? [{ name: 'send', label: 'Send email' }, { name: 'edit', label: 'Edit body' }] : []),
      { name: 'discard', label: 'Discard draft' }];
    case 'question': return [{ name: 'answer', label: 'Answer' }];
    default: return [];
  }
}

function encodeAction(card, input) {
  const { entryId } = card;
  const { name } = input;
  if (!cardActions(card).some(action => action.name === name)) return;
  if (card.kind === 'approval') {
    const local = card.type === 'local-tool-permission';
    const resolution = name === 'approve' ? (local ? 'allow-once' : 'approved') : (local ? 'deny' : 'denied');
    return [local ? 'resolveLocalToolPermission' : 'resolveAutoReviewApproval',
      { entryId, requestId: card.requestId, resolution }];
  }
  if (card.kind === 'email') {
    if (name === 'discard') return ['discardDraft', { entryId }];
    if (name === 'send' && (input.body === undefined || typeof input.body === 'string')) {
      const draft = input.body === undefined ? card.draft : { ...card.draft, body: input.body };
      return ['sendDraft', { entryId, draft }];
    }
    return;
  }
  const { picks, custom = '' } = input;
  if (!Array.isArray(picks) || picks.length !== card.steps.length || typeof custom !== 'string' ||
      (custom && !card.custom)) return;
  const values = [];
  for (const [i, step] of card.steps.entries()) {
    if (!Array.isArray(picks[i]) || (!step.multi && picks[i].length > 1) ||
        picks[i].some(index => !Number.isInteger(index) || !step.options[index])) return;
    const answers = step.options.filter((_, index) => picks[i].includes(index)).map(option => option.value);
    if (custom && i === 0) answers.push(line(custom));
    if (!answers.some(Boolean)) return;
    values.push((card.steps.length > 1 ? [step.prompt, ...answers] : answers).join('\n'));
  }
  return ['respondToWidget', { entryId, value: values.join('\n\n') }];
}

export class CardActionError extends Error {
  constructor(message, { uncertain = false } = {}) {
    super(message);
    this.uncertain = uncertain;
  }
}

// Re-read the exact card before writing. The action comes from local keyboard input;
// the bot supplies only data and cannot select an endpoint or issue the confirmation.
export async function submitCardAction(call, agentId, expected, input, authorize = loadWindowsSendCredentials) {
  if (!validId(agentId) || !expected || !validId(expected.entryId)) {
    throw new CardActionError('This card cannot be matched to the current chat.');
  }
  authorize();
  let transcript;
  try {
    transcript = await call('getAgentTranscriptTail', { id: agentId, limit: 500 }, AbortSignal.timeout(15000));
  } catch {
    throw new CardActionError('Could not refresh this card. Try again after the chat reconnects.');
  }
  const rows = Array.isArray(transcript) ? transcript : transcript?.entries;
  const matches = Array.isArray(rows) ? rows.map(row => row?.kind == null ? row?.entry ?? row : row)
    .filter(row => row?.id === expected.entryId) : [];
  const card = matches.length === 1 ? parseBotCard(matches[0]) : undefined;
  if (!card || !isDeepStrictEqual(card, expected)) {
    throw new CardActionError('The card changed or expired. Review the latest chat before continuing.');
  }
  const action = encodeAction(card, input);
  if (!action) throw new CardActionError('This action is unavailable for the current card.');
  authorize();
  const [method, body] = action;
  let result;
  try {
    result = await call(method, { agentId, ...body }, AbortSignal.timeout(20000));
  } catch (error) {
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 &&
        error.status !== 408 && error.status !== 409) {
      throw new CardActionError('Grok Bot rejected this action (HTTP ' + error.status + ').');
    }
    throw new CardActionError('Result unknown. Check the card in Grok Bot before trying again.', { uncertain: true });
  }
  if (result?.ok === false || result?.success === false || result?.accepted === false) {
    throw new CardActionError('Grok Bot rejected this action.');
  }
}
