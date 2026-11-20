function route(kind, id, name) {
  const label = typeof name === 'string' ? name.trim() : '';
  if (Number.isSafeInteger(id)) id = String(id);
  if (!label || typeof id !== 'string' || !id || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(label + id)) return;
  return { kind, id, label };
}

function unique(items) {
  return [...new Map(items.filter(Boolean).map(item => [item.kind + ':' + item.id, item])).values()];
}

export function agentRoutes(agent, roster) {
  if (agent.isGroup) {
    const byId = new Map([...roster, ...(agent.members ?? [])].map(row => [row.id, row]));
    const ids = new Set([...(agent.memberIds ?? []), ...(agent.members ?? []).map(row => row.id)]);
    return unique([...ids].map(id => route('agent', id, byId.get(id)?.name ?? id)));
  }
  return unique(roster.filter(row => row.id !== agent.id && (!row.isGroup || row.memberIds?.includes(agent.id)))
    .map(row => route(row.isGroup ? 'channel' : 'agent', row.id, row.name)));
}

export function skillRoutes(reply) {
  const workflows = Array.isArray(reply) ? reply : reply?.workflows;
  if (!Array.isArray(workflows)) throw new Error('Invalid skill catalog');
  return unique(workflows.map(row => row && route('skill', row.id, row.name)));
}

function appId(server) {
  if (server.servedBy === 'MCP_SERVED_BY_GROK') {
    return server.serverIdentifier ? 'grok:' + server.serverIdentifier : undefined;
  }
  if (Number.isSafeInteger(server.id) || (typeof server.id === 'string' && /^-?\d+$/u.test(server.id))) {
    return String(server.id);
  }
}

export function appCandidates(account, scoped) {
  const servers = new Map();
  // Bot-specific rows take precedence, including explicit policy blocks.
  for (const reply of [account, scoped]) {
    if (!reply || typeof reply !== 'object' || Array.isArray(reply) ||
        (reply.servers !== undefined && !Array.isArray(reply.servers))) throw new Error('Invalid app catalog');
    for (const row of reply.servers ?? []) {
      if (!row) continue;
      const id = appId(row);
      if (id !== undefined) servers.set(id, row);
    }
  }
  const apps = [];
  for (const [id, row] of servers) {
    if (row.enabled !== true || row.disabledByTeamAdminPolicy || row.disabledByCloudAgentMcpAllowlist ||
        row.needsGrant || row.needsPluginSetup || (row.blockedReason && !String(row.blockedReason).endsWith('_UNSPECIFIED'))) continue;
    const connected = row.userHasAccessToken === true || row.credentialIsCursorAccount === true ||
      row.hasStaticCredentialHeaders === true || (Array.isArray(row.accounts) && row.accounts.some(slot => slot?.userHasAccessToken === true));
    const item = route('app', 'mcp:' + id, row.pluginDisplayName || row.name);
    if (item) apps.push({ item, connected: Boolean(connected), identifier: row.serverIdentifier });
  }
  return apps;
}
