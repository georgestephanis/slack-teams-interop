/**
 * InterBridge Admin UI Frontend Script
 */

document.addEventListener('DOMContentLoaded', () => {
  const mappingsTbody = document.getElementById('mappings-tbody');
  const metricBridges = document.getElementById('metric-bridges');
  const metricMessages = document.getElementById('metric-messages');
  const metricSlackStatus = document.getElementById('metric-slack-status');
  const metricSlackMode = document.getElementById('metric-slack-mode');
  const metricTeamsStatus = document.getElementById('metric-teams-status');
  const mappingCount = document.getElementById('mapping-count');
  const activityFeed = document.getElementById('activity-feed');

  // Modal elements
  const modalMapping = document.getElementById('modal-mapping');
  const btnAddMapping = document.getElementById('btn-add-mapping');
  const btnModalClose = document.getElementById('btn-modal-close');
  const btnModalCancel = document.getElementById('btn-modal-cancel');
  const formMapping = document.getElementById('form-mapping');
  const btnRefresh = document.getElementById('btn-refresh');

  // Teams connection elements
  const connectionsTbody = document.getElementById('connections-tbody');
  const connectionsKeyless = document.getElementById('connections-keyless');
  const btnAddConnection = document.getElementById('btn-add-connection');
  const modalConnection = document.getElementById('modal-connection');
  const formConnection = document.getElementById('form-connection');
  const selectMappingConnection = document.getElementById('teams-connection-id');
  let teamsConnections = [];
  let canStoreConnections = false;

  // Load Initial Data
  loadDashboard();

  // Periodic Refresh
  setInterval(loadDashboard, 10000);

  // Event Listeners
  btnRefresh.addEventListener('click', loadDashboard);

  btnAddMapping.addEventListener('click', () => {
    document.getElementById('modal-title').textContent = 'New Channel Bridge';
    document.getElementById('mapping-id').value = '';
    formMapping.reset();
    renderConnectionOptions();
    document.getElementById('sync-threads').checked = true;
    document.getElementById('sync-reactions').checked = true;
    document.getElementById('sync-files').checked = true;
    document.getElementById('unsupported-notices').checked = true;
    document.getElementById('sync-edits').checked = true;
    document.getElementById('sync-deletes').checked = true;
    modalMapping.classList.remove('hidden');
  });

  btnModalClose.addEventListener('click', () => modalMapping.classList.add('hidden'));
  btnModalCancel.addEventListener('click', () => modalMapping.classList.add('hidden'));

  btnAddConnection.addEventListener('click', () => openConnectionModal());
  document.getElementById('btn-connection-close').addEventListener('click', () => modalConnection.classList.add('hidden'));
  document.getElementById('btn-connection-cancel').addEventListener('click', () => modalConnection.classList.add('hidden'));

  formConnection.addEventListener('submit', async (e) => {
    e.preventDefault();
    const idInput = document.getElementById('connection-id');
    const secret = document.getElementById('connection-secret').value;
    const payload = {
      id: idInput.value.trim(),
      name: document.getElementById('connection-name').value.trim(),
      appId: document.getElementById('connection-app-id').value.trim(),
      tenantId: document.getElementById('connection-tenant-id').value.trim(),
      appType: 'SingleTenant',
      secretExpiresAt: document.getElementById('connection-expires').value || undefined,
      enabled: document.getElementById('connection-enabled').checked,
      // Omitted on edit when left blank, which keeps the stored secret
      appPassword: secret || undefined,
    };

    try {
      const res = await fetch('/api/teams-connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save connection');
      modalConnection.classList.add('hidden');
      addLog(`Saved Teams connection: ${payload.name}`);
      loadDashboard();
    } catch (err) {
      alert(`Error saving connection: ${err.message}`);
    }
  });

  // Handle Form Submission
  formMapping.addEventListener('submit', async (e) => {
    e.preventDefault();

    const id = document.getElementById('mapping-id').value || crypto.randomUUID();
    const payload = {
      id,
      name: document.getElementById('mapping-name').value.trim(),
      enabled: true,
      slack: {
        channelId: document.getElementById('slack-channel-id').value.trim(),
        channelName: document.getElementById('slack-channel-name').value.trim() || undefined,
      },
      teams: {
        teamId: document.getElementById('teams-team-id').value.trim(),
        channelId: document.getElementById('teams-channel-id').value.trim(),
        connectionId: selectMappingConnection.value || undefined,
      },
      options: {
        teamsFormatStyle: document.getElementById('teams-format-style').value,
        syncThreads: document.getElementById('sync-threads').checked,
        syncReactions: document.getElementById('sync-reactions').checked,
        reactionNotices: document.getElementById('reaction-notices').checked,
        unsupportedNotices: document.getElementById('unsupported-notices').checked,
        syncFiles: document.getElementById('sync-files').checked,
        syncEdits: document.getElementById('sync-edits').checked,
        syncDeletes: document.getElementById('sync-deletes').checked,
      },
    };

    try {
      const res = await fetch('/api/mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to save mapping');

      modalMapping.classList.add('hidden');
      loadDashboard();
      addLog(`Created/updated bridge: ${payload.name}`);
    } catch (err) {
      alert(`Error saving mapping: ${err.message}`);
    }
  });

  async function loadDashboard() {
    try {
      // 1. Fetch Health & Metrics
      const healthRes = await fetch('/api/health');
      if (healthRes.ok) {
        const health = await healthRes.json();
        updateHealthMetrics(health);
      }

      // 2. Fetch Teams connections (mappings display their names)
      const connectionsRes = await fetch('/api/teams-connections');
      if (connectionsRes.ok) {
        const data = await connectionsRes.json();
        teamsConnections = data.connections || [];
        canStoreConnections = Boolean(data.canStore);
        renderConnections();
      }

      // 3. Fetch Mappings
      const mappingsRes = await fetch('/api/mappings');
      if (mappingsRes.ok) {
        const mappings = await mappingsRes.json();
        renderMappings(mappings);
      }
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
    }
  }

  function updateHealthMetrics(health) {
    metricBridges.textContent = health.activeBridges ?? 0;
    metricMessages.textContent = health.relayedMessages ?? 0;

    // Slack Status
    if (health.slack?.connected) {
      metricSlackStatus.className = 'metric-value status-indicator online';
      metricSlackStatus.querySelector('.status-label').textContent = 'Connected';
    } else {
      metricSlackStatus.className = 'metric-value status-indicator offline';
      metricSlackStatus.querySelector('.status-label').textContent = health.slack?.configured ? 'Offline' : 'Unconfigured';
    }
    metricSlackMode.textContent = health.slack?.socketMode ? 'Socket Mode (WebSocket)' : 'HTTP Webhook';

    // Teams Status
    if (health.teams?.configured) {
      metricTeamsStatus.className = 'metric-value status-indicator online';
      const count = health.teams.connections ?? 1;
      metricTeamsStatus.querySelector('.status-label').textContent = count === 1 ? 'Ready' : `Ready (${count} tenants)`;
    } else {
      metricTeamsStatus.className = 'metric-value status-indicator offline';
      metricTeamsStatus.querySelector('.status-label').textContent = 'Unconfigured';
    }
  }

  function renderMappings(mappings) {
    mappingCount.textContent = `${mappings.length} ${mappings.length === 1 ? 'channel' : 'channels'}`;

    if (!mappings || mappings.length === 0) {
      mappingsTbody.innerHTML = `
        <tr>
          <td colspan="7" class="empty-state">No channel bridges configured yet. Click "Add Channel Bridge" to get started.</td>
        </tr>`;
      return;
    }

    mappingsTbody.innerHTML = mappings
      .map((m) => {
        const slackDisplay = m.slack.channelName ? `${m.slack.channelName} (${m.slack.channelId})` : m.slack.channelId;
        const teamsDisplay = m.teams.channelName ? `${m.teams.channelName} (${m.teams.channelId.substring(0, 12)}...)` : `${m.teams.channelId.substring(0, 16)}...`;
        const formatBadge = m.options.teamsFormatStyle === 'adaptive_card' ? 'Adaptive Card' : 'Markdown';

        const features = [];
        if (m.options.syncThreads) features.push('Threads');
        if (m.options.syncReactions) features.push(m.options.reactionNotices ? 'Reactions (+notices)' : 'Reactions');
        if (m.options.syncEdits) features.push('Edits');
        if (m.options.syncDeletes) features.push('Deletes');
        if (m.options.syncFiles) features.push('Files');

        return `
          <tr>
            <td><strong>${escapeHtml(m.name)}</strong></td>
            <td><span class="channel-tag slack"># ${escapeHtml(slackDisplay)}</span></td>
            <td>
              <span class="channel-tag teams">T ${escapeHtml(teamsDisplay)}</span>
              ${teamsConnections.length > 1 ? `<small class="connection-note">via ${escapeHtml(connectionName(m.teams.connectionId))}</small>` : ''}
              ${m.status && !m.status.teamsServiceUrlKnown ? '<small class="warn-note" title="No activity seen from this Teams channel yet. Posts use a service URL learned from the same team or tenant if one is known, otherwise TEAMS_SERVICE_URL.">⚠ region not yet detected</small>' : ''}
            </td>
            <td><span class="badge">${formatBadge}</span></td>
            <td><small>${features.join(' • ')}</small></td>
            <td>
              <span class="status-badge ${m.enabled ? 'active' : 'paused'}">
                ${m.enabled ? 'Active' : 'Paused'}
              </span>
            </td>
            <td>
              <button class="btn btn-sm btn-outline btn-test" data-id="${escapeHtml(m.id)}" title="Send test diagnostic message">Test</button>
              <button class="btn-danger-sm btn-delete" data-id="${escapeHtml(m.id)}" title="Delete bridge">Delete</button>
            </td>
          </tr>
        `;
      })
      .join('');

    // Attach row button events
    document.querySelectorAll('.btn-test').forEach((btn) => {
      btn.addEventListener('click', () => sendTestMessage(btn.dataset.id));
    });

    document.querySelectorAll('.btn-delete').forEach((btn) => {
      btn.addEventListener('click', () => deleteMapping(btn.dataset.id));
    });
  }

  /** Default connection id: the env (TEAMS_APP_ID) one, which mappings without an id use. */
  function defaultConnectionId() {
    return teamsConnections.find((c) => c.source === 'env')?.id;
  }

  function connectionName(id) {
    const c = teamsConnections.find((x) => x.id === (id || defaultConnectionId()));
    return c ? c.name : id || 'default';
  }

  function renderConnectionOptions(selected) {
    const fallback = defaultConnectionId();
    selectMappingConnection.innerHTML = teamsConnections.length
      ? teamsConnections
          .map((c) => `<option value="${c.source === 'env' ? '' : escapeHtml(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.id)})</option>`)
          .join('')
      : '<option value="">No Teams connections yet</option>';
    // With no env connection there's no '' option, so pick the first stored one
    selectMappingConnection.value = selected && selected !== fallback ? selected : fallback ? '' : teamsConnections[0]?.id || '';
  }

  function openConnectionModal(connection) {
    formConnection.reset();
    const idInput = document.getElementById('connection-id');
    document.getElementById('connection-modal-title').textContent = connection ? `Edit ${connection.name}` : 'New Teams Connection';
    idInput.readOnly = Boolean(connection);
    document.getElementById('connection-secret').required = !connection;
    document.getElementById('connection-secret-help').textContent = connection
      ? 'Leave blank to keep the current secret. Stored encrypted.'
      : 'Stored encrypted. Never shown again.';
    if (connection) {
      idInput.value = connection.id;
      document.getElementById('connection-name').value = connection.name;
      document.getElementById('connection-app-id').value = connection.appId;
      document.getElementById('connection-tenant-id').value = connection.tenantId || '';
      document.getElementById('connection-expires').value = (connection.secretExpiresAt || '').slice(0, 10);
      document.getElementById('connection-enabled').checked = connection.enabled;
    }
    modalConnection.classList.remove('hidden');
  }

  function renderConnections() {
    connectionsKeyless.classList.toggle('hidden', canStoreConnections);
    btnAddConnection.disabled = !canStoreConnections;

    if (teamsConnections.length === 0) {
      connectionsTbody.innerHTML = '<tr><td colspan="5" class="empty-state">No Teams connections yet.</td></tr>';
      return;
    }

    const soon = Date.now() + 30 * 24 * 60 * 60 * 1000;
    connectionsTbody.innerHTML = teamsConnections
      .map((c) => {
        const expires = c.secretExpiresAt ? Date.parse(c.secretExpiresAt) : NaN;
        const expiryNote = Number.isNaN(expires)
          ? ''
          : expires < Date.now()
            ? '<small class="warn-note">⚠ client secret expired</small>'
            : expires < soon
              ? `<small class="warn-note">⚠ secret expires ${escapeHtml(c.secretExpiresAt.slice(0, 10))}</small>`
              : '';
        const seen = c.lastActivityAt ? `Last activity ${escapeHtml(c.lastActivityAt)} UTC` : 'No activity yet';
        const status = !c.enabled ? ['paused', 'Disabled'] : c.active ? ['active', 'Active'] : ['paused', 'Inactive'];
        const actions =
          c.source === 'env'
            ? '<small>Set in environment</small>'
            : `<button class="btn btn-sm btn-outline btn-conn-test" data-id="${escapeHtml(c.id)}">Test</button>
               <button class="btn btn-sm btn-outline btn-conn-edit" data-id="${escapeHtml(c.id)}">Edit</button>
               <button class="btn-danger-sm btn-conn-delete" data-id="${escapeHtml(c.id)}">Delete</button>`;
        return `
          <tr>
            <td><strong>${escapeHtml(c.name)}</strong><br><small>${escapeHtml(c.id)}</small>${expiryNote}</td>
            <td>
              <span class="endpoint-url">${escapeHtml(c.messagingEndpoint)}</span><br>
              <a href="/api/manifests/teams?connection=${encodeURIComponent(c.id)}" class="btn btn-sm btn-outline">Teams App Package</a>
            </td>
            <td>${escapeHtml(String(c.bridges ?? 0))}</td>
            <td><span class="status-badge ${status[0]}">${status[1]}</span><br><small>${seen}</small></td>
            <td>${actions}</td>
          </tr>`;
      })
      .join('');

    document.querySelectorAll('.btn-conn-edit').forEach((btn) => {
      btn.addEventListener('click', () => openConnectionModal(teamsConnections.find((c) => c.id === btn.dataset.id)));
    });
    document.querySelectorAll('.btn-conn-test').forEach((btn) => {
      btn.addEventListener('click', () => testConnection(btn.dataset.id));
    });
    document.querySelectorAll('.btn-conn-delete').forEach((btn) => {
      btn.addEventListener('click', () => deleteConnection(btn.dataset.id));
    });
  }

  async function testConnection(id) {
    addLog(`Checking credentials for Teams connection ${id}...`);
    const res = await fetch(`/api/teams-connections/${encodeURIComponent(id)}/test`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    addLog(res.ok ? `${id}: ${data.message}` : `${id}: ${data.error || 'check failed'}`);
  }

  async function deleteConnection(id) {
    if (!confirm(`Delete Teams connection "${id}"? Its bot will stop relaying immediately.`)) return;
    const res = await fetch(`/api/teams-connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      addLog(`Deleted Teams connection: ${id}`);
      loadDashboard();
    } else {
      alert(data.error || 'Failed to delete connection');
    }
  }

  async function sendTestMessage(id) {
    try {
      addLog(`Sending test message across bridge ID: ${id}...`);
      const res = await fetch(`/api/mappings/${encodeURIComponent(id)}/test`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        addLog(`Test message sent: ${data.message}`);
      } else {
        addLog(`Test message failed: ${data.error || 'Unknown error'}`);
      }
    } catch (err) {
      addLog(`Error testing bridge: ${err.message}`);
    }
  }

  async function deleteMapping(id) {
    if (!confirm('Are you sure you want to delete this channel bridge?')) return;
    try {
      const res = await fetch(`/api/mappings/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.ok) {
        addLog(`Deleted channel bridge: ${id}`);
        loadDashboard();
      }
    } catch (err) {
      alert(`Failed to delete: ${err.message}`);
    }
  }

  function addLog(text) {
    const item = document.createElement('div');
    item.className = 'feed-item relay';
    item.innerHTML = `
      <span class="feed-time">${new Date().toLocaleTimeString()}</span>
      <span class="feed-text">${escapeHtml(text)}</span>
    `;
    activityFeed.prepend(item);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
});
