// State
let importPollTimer = null;

// DOM
const loginScreen = document.getElementById('login-screen');
const dashboard = document.getElementById('dashboard');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');

// -- Auth --

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = document.getElementById('password');
  const btn = loginForm.querySelector('button');
  btn.disabled = true;
  loginError.textContent = '';
  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw.value }),
    });
    if (res.ok) {
      pw.value = '';
      showDashboard();
    } else {
      loginError.textContent = 'Invalid password';
    }
  } catch {
    loginError.textContent = 'Connection error';
  } finally {
    btn.disabled = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  showLogin();
});

function showLogin() {
  dashboard.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  loginScreen.style.display = '';
}

function showDashboard() {
  loginScreen.classList.add('hidden');
  loginScreen.style.display = 'none';
  dashboard.classList.remove('hidden');
  loadAll();
}

// -- Load all dashboard data --

async function loadAll() {
  // Fire all loads in parallel
  await Promise.allSettled([
    loadStatus(),
    loadYouTubeStatus(),
    loadChannels(),
    loadProfile(),
    loadGuidelines(),
    loadHistory(),
    loadBlocked(),
  ]);
}

// -- Status Panel --

async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    if (res.status === 401) return showLogin();
    const data = await res.json();
    document.getElementById('status-uptime').textContent = formatUptime(data.uptime);
    document.getElementById('status-youtube').innerHTML = data.youtubeConnected
      ? '<span class="dot dot-green"></span>Connected'
      : '<span class="dot dot-red"></span>Not connected';
    document.getElementById('status-channels').textContent = data.channelCount;
    document.getElementById('status-videos').textContent = data.videoCount;
    document.getElementById('status-watches').textContent = data.watchCount;
  } catch { /* ignore */ }
}

function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// -- YouTube Connection --

async function loadYouTubeStatus() {
  const container = document.getElementById('youtube-status');
  try {
    const res = await fetch('/api/youtube/status');
    if (res.status === 401) return;
    const data = await res.json();

    if (data.connected) {
      const expiry = data.expiryTime ? new Date(data.expiryTime).toLocaleString() : 'Unknown';
      container.innerHTML = `
        <div class="youtube-connected">
          <div class="youtube-info">
            <p><span class="dot dot-green"></span><strong>Connected</strong></p>
            <p class="text-muted">Token expires: ${escapeHTML(expiry)}</p>
          </div>
          <button id="youtube-disconnect-btn" class="btn-danger">Disconnect</button>
        </div>`;
      document.getElementById('youtube-disconnect-btn').addEventListener('click', disconnectYouTube);
    } else if (!data.oauthConfigured) {
      container.innerHTML = `
        <p class="text-muted" style="margin-bottom: 10px">
          <span class="dot dot-red"></span>Not configured
        </p>
        <p class="text-muted">Set <code>YOURTUBE_YOUTUBE_CLIENT_ID</code> and <code>YOURTUBE_YOUTUBE_CLIENT_SECRET</code> environment variables to enable YouTube OAuth.</p>`;
    } else {
      container.innerHTML = `
        <p class="text-muted" style="margin-bottom: 10px">
          <span class="dot dot-red"></span>Not connected
        </p>
        <a href="/auth/youtube" class="btn-secondary" style="display:inline-block;text-decoration:none">Connect YouTube Account</a>`;
    }
  } catch {
    container.innerHTML = '<p class="text-muted">Failed to check status</p>';
  }

  // Handle OAuth redirect params
  const params = new URLSearchParams(window.location.search);
  if (params.get('youtube') === 'connected') {
    window.history.replaceState({}, '', '/admin');
    loadYouTubeStatus();
  }
  if (params.get('error')) {
    const errorCode = params.get('error');
    const errorMessages = {
      oauth_not_configured: 'YouTube OAuth is not configured. Set YOURTUBE_YOUTUBE_CLIENT_ID and YOURTUBE_YOUTUBE_CLIENT_SECRET environment variables.',
      not_authenticated: 'You need to log in first.',
      invalid_state: 'OAuth session expired. Please try again.',
      auth_failed: 'YouTube authentication failed. Please try again.',
    };
    const errorText = errorMessages[errorCode] || errorCode;
    container.innerHTML += `<p class="error" style="margin-top:8px">${escapeHTML(errorText)}</p>`;
    window.history.replaceState({}, '', '/admin');
  }
}

async function disconnectYouTube() {
  if (!confirm('Disconnect YouTube? You will need to re-authenticate.')) return;
  try {
    await fetch('/api/youtube', { method: 'DELETE' });
    loadYouTubeStatus();
    loadStatus();
  } catch { /* ignore */ }
}

// -- Import --

document.getElementById('import-subs-btn').addEventListener('click', () => runImport('subscriptions'));
document.getElementById('import-liked-btn').addEventListener('click', () => runImport('liked'));

async function runImport(type) {
  const btn = document.getElementById(type === 'subscriptions' ? 'import-subs-btn' : 'import-liked-btn');
  btn.disabled = true;
  const statusEl = document.getElementById('import-status');
  const statusText = document.getElementById('import-status-text');
  statusEl.classList.remove('hidden');
  statusText.textContent = `Starting ${type} import...`;

  try {
    const res = await fetch(`/api/import/${type}`, { method: 'POST' });
    if (res.status === 401) return showLogin();
    const data = await res.json();
    if (data.error) {
      statusText.textContent = `Error: ${data.error}`;
    } else {
      const added = data.added ?? 0;
      const skipped = data.skipped ?? 0;
      if (skipped > 0) {
        statusText.textContent = `Import complete. ${added} new, ${skipped} already imported.`;
      } else {
        statusText.textContent = `Import complete. ${added} items imported.`;
      }
      loadChannels();
      loadStatus();
    }
  } catch {
    statusText.textContent = 'Import failed — check server logs.';
  } finally {
    btn.disabled = false;
  }
}

// -- Channels --

async function loadChannels() {
  const list = document.getElementById('channel-list');
  try {
    const res = await fetch('/api/channels');
    if (res.status === 401) return;
    const data = await res.json();
    const channels = data.channels || [];

    if (channels.length === 0) {
      list.innerHTML = '<p class="text-muted">No channels yet. Import subscriptions or add manually.</p>';
      return;
    }

    list.innerHTML = '';
    for (const ch of channels) {
      const item = document.createElement('div');
      item.className = 'list-item';
      item.innerHTML = `
        <div class="list-item-info">
          <div class="list-item-title">${escapeHTML(ch.title || ch.channelId)}</div>
          <div class="list-item-meta">${escapeHTML(ch.channelId)} &middot; ${escapeHTML(ch.source || 'unknown')}</div>
        </div>
        <div class="list-item-actions">
          <label class="toggle" title="${ch.approved ? 'Approved' : 'Not approved'}">
            <input type="checkbox" ${ch.approved ? 'checked' : ''} data-channel-id="${escapeAttr(ch.channelId)}">
            <span class="toggle-slider"></span>
          </label>
          <button class="btn-danger" data-remove-channel="${escapeAttr(ch.channelId)}">Remove</button>
        </div>`;
      list.appendChild(item);
    }

    // Event delegation for toggles and removes
    list.querySelectorAll('.toggle input').forEach(input => {
      input.addEventListener('change', () => {
        const label = input.closest('.toggle');
        if (label) label.title = input.checked ? 'Approved' : 'Not approved';
        toggleChannel(input.dataset.channelId, input.checked);
      });
    });
    list.querySelectorAll('[data-remove-channel]').forEach(btn => {
      btn.addEventListener('click', () => removeChannel(btn.dataset.removeChannel));
    });
  } catch {
    list.innerHTML = '<p class="text-muted">Failed to load channels</p>';
  }
}

async function toggleChannel(channelId, approved) {
  try {
    await fetch(`/api/channels/${encodeURIComponent(channelId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved }),
    });
  } catch { /* ignore — toggle stays visually where user put it */ }
}

async function removeChannel(channelId) {
  if (!confirm(`Remove this channel?`)) return;
  try {
    await fetch(`/api/channels/${encodeURIComponent(channelId)}`, { method: 'DELETE' });
    loadChannels();
    loadStatus();
  } catch { /* ignore */ }
}

document.getElementById('add-channel-btn').addEventListener('click', async () => {
  const idInput = document.getElementById('add-channel-id');
  const titleInput = document.getElementById('add-channel-title');
  const channelId = idInput.value.trim();
  const title = titleInput.value.trim();

  if (!channelId || !title) return;

  const btn = document.getElementById('add-channel-btn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, title }),
    });
    if (res.ok) {
      idInput.value = '';
      titleInput.value = '';
      loadChannels();
      loadStatus();
    } else {
      const data = await res.json();
      alert(data.error || 'Failed to add channel');
    }
  } catch {
    alert('Failed to add channel');
  } finally {
    btn.disabled = false;
  }
});

// -- Taste Profile --

async function loadProfile() {
  const content = document.getElementById('profile-content');
  try {
    const res = await fetch('/api/profile');
    if (res.status === 401) return;
    const data = await res.json();
    const profile = data.profile;

    if (!profile) {
      content.innerHTML = '<p class="text-muted">No profile generated yet.</p>';
      return;
    }

    let html = '';
    if (profile.interests && profile.interests.length > 0) {
      html += '<h4 style="margin:0 0 6px">Interests</h4>';
      html += '<div class="profile-tags">';
      for (const item of profile.interests) {
        html += `<span class="tag">${escapeHTML(item)}</span>`;
      }
      html += '</div>';
    }
    if (profile.preferredFormats && profile.preferredFormats.length > 0) {
      html += '<h4 style="margin:12px 0 6px">Preferred Formats</h4>';
      html += '<div class="profile-tags">';
      for (const item of profile.preferredFormats) {
        html += `<span class="tag">${escapeHTML(item)}</span>`;
      }
      html += '</div>';
    }
    if (profile.avoidPatterns && profile.avoidPatterns.length > 0) {
      html += '<h4 style="margin:12px 0 6px">Avoid Patterns</h4>';
      html += '<div class="profile-tags">';
      for (const item of profile.avoidPatterns) {
        html += `<span class="tag tag-avoid">${escapeHTML(item)}</span>`;
      }
      html += '</div>';
    }
    if (profile.discoveryTerms && profile.discoveryTerms.length > 0) {
      html += '<h4 style="margin:12px 0 6px">Discovery Terms</h4>';
      html += '<div class="profile-tags">';
      for (const item of profile.discoveryTerms) {
        html += `<span class="tag">${escapeHTML(item)}</span>`;
      }
      html += '</div>';
    }
    if (!html) {
      // Fallback: show raw JSON excluding rawResponse
      const displayProfile = Object.fromEntries(
        Object.entries(profile).filter(([k]) => k !== 'rawResponse')
      );
      html = `<pre class="text-muted" style="white-space:pre-wrap;font-size:0.85rem">${escapeHTML(JSON.stringify(displayProfile, null, 2))}</pre>`;
    } else {
      // Append raw JSON (excluding rawResponse) as a collapsible detail
      const displayProfile = Object.fromEntries(
        Object.entries(profile).filter(([k]) => !['rawResponse', 'generatedAt', 'sampleSize'].includes(k))
      );
      html += `<details style="margin-top:12px"><summary class="text-muted" style="cursor:pointer;font-size:0.85rem">Raw JSON</summary>`;
      html += `<pre class="text-muted" style="white-space:pre-wrap;font-size:0.85rem;margin-top:6px">${escapeHTML(JSON.stringify(displayProfile, null, 2))}</pre>`;
      html += `</details>`;
    }
    content.innerHTML = html;
  } catch {
    content.innerHTML = '<p class="text-muted">Failed to load profile</p>';
  }
}

document.getElementById('rebuild-profile-btn').addEventListener('click', async () => {
  const btn = document.getElementById('rebuild-profile-btn');
  btn.disabled = true;
  btn.textContent = 'Rebuilding...';
  try {
    const res = await fetch('/api/profile/rebuild', { method: 'POST' });
    if (res.status === 401) return showLogin();
    await loadProfile();
  } catch { /* ignore */ }
  finally {
    btn.disabled = false;
    btn.textContent = 'Rebuild Profile';
  }
});

// -- Content Guidelines --

async function loadGuidelines() {
  try {
    const res = await fetch('/api/config');
    if (res.status === 401) return;
    const data = await res.json();
    const config = data.config || {};
    document.getElementById('guidelines-text').value = config.guidelines || '';
  } catch { /* ignore */ }
}

document.getElementById('save-guidelines-btn').addEventListener('click', async () => {
  const btn = document.getElementById('save-guidelines-btn');
  const saved = document.getElementById('guidelines-saved');
  const guidelines = document.getElementById('guidelines-text').value;

  btn.disabled = true;
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guidelines }),
    });
    if (res.ok) {
      saved.classList.remove('hidden');
      setTimeout(() => saved.classList.add('hidden'), 2000);
    }
  } catch { /* ignore */ }
  finally {
    btn.disabled = false;
  }
});

// -- Watch History --

async function loadHistory() {
  const list = document.getElementById('history-list');
  try {
    const res = await fetch('/api/history');
    if (res.status === 401) return;
    const data = await res.json();
    const history = data.history || [];

    if (history.length === 0) {
      list.innerHTML = '<p class="text-muted">No watch history yet.</p>';
      return;
    }

    list.innerHTML = '';
    for (const entry of history.slice(0, 50)) {
      const item = document.createElement('div');
      item.className = 'list-item';
      const duration = entry.duration ? formatDuration(entry.duration) : '';
      const time = entry.startedAt ? formatRelativeTime(entry.startedAt) : '';
      item.innerHTML = `
        <div class="list-item-info">
          <div class="list-item-title">${escapeHTML(entry.title || entry.videoId)}</div>
          <div class="list-item-meta">${escapeHTML(entry.channelTitle || '')}${duration ? ` &middot; ${duration}` : ''}</div>
        </div>
        <span class="history-time">${escapeHTML(time)}</span>`;
      list.appendChild(item);
    }
  } catch {
    list.innerHTML = '<p class="text-muted">Failed to load history</p>';
  }
}

// -- Blocked Items --

async function loadBlocked() {
  const list = document.getElementById('blocked-list');
  try {
    const res = await fetch('/api/blocked');
    if (res.status === 401) return;
    const data = await res.json();
    const blocked = data.blocked || { channels: [], videos: [] };

    const allItems = [
      ...blocked.channels.map(id => ({ type: 'channel', id })),
      ...blocked.videos.map(id => ({ type: 'video', id })),
    ];

    if (allItems.length === 0) {
      list.innerHTML = '<p class="text-muted">No blocked items.</p>';
      return;
    }

    list.innerHTML = '';
    for (const item of allItems) {
      const el = document.createElement('div');
      el.className = 'list-item';
      el.innerHTML = `
        <div class="list-item-info">
          <div class="list-item-title">${escapeHTML(item.id)}</div>
          <div class="list-item-meta">${item.type === 'channel' ? 'Channel' : 'Video'}</div>
        </div>
        <button class="btn-danger" data-unblock-type="${item.type}" data-unblock-id="${escapeAttr(item.id)}">Unblock</button>`;
      list.appendChild(el);
    }

    list.querySelectorAll('[data-unblock-type]').forEach(btn => {
      btn.addEventListener('click', () => unblock(btn.dataset.unblockType, btn.dataset.unblockId));
    });
  } catch {
    list.innerHTML = '<p class="text-muted">Failed to load blocked items</p>';
  }
}

async function unblock(type, id) {
  try {
    await fetch(`/api/block/${type}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    loadBlocked();
  } catch { /* ignore */ }
}

document.getElementById('block-btn').addEventListener('click', async () => {
  const type = document.getElementById('block-type').value;
  const idInput = document.getElementById('block-id');
  const id = idInput.value.trim();
  if (!id) return;

  try {
    const res = await fetch('/api/block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, id }),
    });
    if (res.ok) {
      idInput.value = '';
      loadBlocked();
    }
  } catch { /* ignore */ }
});

// -- Utilities --

function escapeHTML(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return escapeHTML(str);
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatRelativeTime(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay === 1) return 'Yesterday';
    if (diffDay < 7) return `${diffDay}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

// -- Init --

async function init() {
  try {
    const res = await fetch('/api/admin/session');
    const data = await res.json();
    if (data.authenticated) {
      showDashboard();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

init();
