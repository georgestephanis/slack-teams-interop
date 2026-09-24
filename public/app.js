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
  const btnCopyWebhook = document.getElementById('btn-copy-webhook');

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
    document.getElementById('sync-threads').checked = true;
    document.getElementById('sync-reactions').checked = true;
    document.getElementById('sync-files').checked = true;
    document.getElementById('sync-edits').checked = true;
    document.getElementById('sync-deletes').checked = true;
    modalMapping.classList.remove('hidden');
  });

  btnModalClose.addEventListener('click', () => modalMapping.classList.add('hidden'));
  btnModalCancel.addEventListener('click', () => modalMapping.classList.add('hidden'));

  btnCopyWebhook.addEventListener('click', () => {
    const webhookUrl = `${window.location.origin}/api/messages`;
    navigator.clipboard.writeText(webhookUrl).then(() => {
      btnCopyWebhook.textContent = 'Copied!';
      setTimeout(() => (btnCopyWebhook.textContent = 'Copy Webhook URL'), 2000);
    });
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
      },
      options: {
        teamsFormatStyle: document.getElementById('teams-format-style').value,
        syncThreads: document.getElementById('sync-threads').checked,
        syncReactions: document.getElementById('sync-reactions').checked,
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

      if (!res.ok) throw new Error('Failed to save mapping');

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

      // 2. Fetch Mappings
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
      metricTeamsStatus.querySelector('.status-label').textContent = 'Ready';
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
        if (m.options.syncReactions) features.push('Reactions');
        if (m.options.syncEdits) features.push('Edits');
        if (m.options.syncDeletes) features.push('Deletes');
        if (m.options.syncFiles) features.push('Files');

        return `
          <tr>
            <td><strong>${escapeHtml(m.name)}</strong></td>
            <td><span class="channel-tag slack"># ${escapeHtml(slackDisplay)}</span></td>
            <td>
              <span class="channel-tag teams">T ${escapeHtml(teamsDisplay)}</span>
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
