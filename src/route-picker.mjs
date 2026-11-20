import { upstreamDependency } from './upstream.mjs';
import { agentRoutes } from './route-catalog.mjs';
import { routeQuery, trackRouteEdit } from './route-draft.mjs';

const { useCallback, useEffect, useMemo, useState } = await import(upstreamDependency('react'));
const mockSkills = [{ kind: 'skill', id: 'demo-summary', label: 'Summarize notes' }];
const mockApps = [{ kind: 'app', id: 'mcp:demo-calendar', label: 'Demo Calendar' }];

function readCatalog(client, trigger, agentId, signal) {
  if (client.source === 'mock') return trigger === '/' ? mockSkills : mockApps;
  return trigger === '/' ? client.listRouteSkills(agentId, signal) : client.listRouteApps(agentId, signal);
}

export function useRouteDraft(initial) {
  const [draft, update] = useState(initial);
  const setDraft = useCallback(change => {
    update(previous => trackRouteEdit(previous, typeof change === 'function' ? change(previous) : change));
  }, []);
  return [draft, setDraft];
}

export function useRoutePicker({ draft, agent, roster, client, enabled }) {
  const query = enabled ? routeQuery(draft) : null;
  const trigger = query?.trigger;
  const { id: agentId } = agent;
  const cache = useMemo(() => new Map(), [client, agentId]);
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!trigger) return;
    const cached = cache.get(trigger);
    const state = { trigger, cache };
    if (cached && Date.now() < cached.expires) {
      setResult({ ...state, ...cached });
      return;
    }
    const controller = new AbortController();
    setResult({ ...state, loading: true });
    Promise.resolve().then(() => readCatalog(client, trigger, agentId, controller.signal)).then(reply => {
      if (controller.signal.aborted) return;
      const ready = { ...(Array.isArray(reply) ? { items: reply } : reply), expires: Date.now() + 30000 };
      if (!ready.partial) cache.set(trigger, ready);
      setResult({ ...state, ...ready });
    }).catch(() => {
      if (!controller.signal.aborted) setResult({ ...state, failed: true });
    });
    return () => controller.abort();
  }, [client, trigger, agentId, cache]);

  const current = trigger && result?.trigger === trigger && result.cache === cache ? result : undefined;
  const agents = useMemo(() => agentRoutes(agent, roster), [agent, roster]);
  const needle = query?.prefix.toLowerCase();
  const matches = useMemo(() => {
    if (!trigger) return [];
    const items = trigger === '@' ? [...agents, ...(current?.items ?? [])] : current?.items ?? [];
    const duplicates = new Map();
    for (const item of items) {
      const key = item.kind + ':' + item.label.toLowerCase();
      duplicates.set(key, (duplicates.get(key) ?? 0) + 1);
    }
    return items.filter(item => item.label.toLowerCase().includes(needle) || item.id.toLowerCase().includes(needle))
      .map(item => ({
        ...item, detail: duplicates.get(item.kind + ':' + item.label.toLowerCase()) > 1
          ? item.kind + ' · ' + item.id : item.kind,
      }));
  }, [trigger, needle, agents, current]);
  let note = '';
  if (trigger) {
    const source = trigger === '/' ? 'skills' : 'apps';
    if (!current || current.loading) note = 'Loading ' + source + '…';
    else if (current.failed) note = 'Could not load ' + source;
    else if (current.partial) note = 'Some app statuses unavailable';
    else if (!matches.length) note = 'No matching ' + (trigger === '/' ? 'skills' : 'agents or apps');
  }
  const literal = query?.prefix.includes(' ') && !matches.length && current && !current.loading;
  return { query: literal ? null : query, matches, note };
}
