/**
 * YourTube Admin Dashboard
 */

// ---- Constants ----

const AVAILABLE_INTERESTS = [
  // Creative & expressive
  'art', 'music', 'dance', 'crafts', 'cooking', 'animation',
  // Active & physical
  'sports', 'parkour', 'yoga-mindfulness',
  // Curiosity & discovery
  'animals', 'nature', 'dinosaurs', 'space', 'science', 'history', 'geography',
  // Building & making
  'lego', 'engineering', 'robots', 'coding',
  // Games & challenges
  'gaming', 'chess', 'puzzles', 'magic',
  // Stories & language
  'reading', 'languages', 'comedy',
  // Other
  'vehicles',
];

const INTEREST_LABELS = {
  'gaming': 'Gaming',
  'science': 'Science',
  'engineering': 'Engineering',
  'nature': 'Nature',
  'animals': 'Animals',
  'dinosaurs': 'Dinosaurs',
  'space': 'Space',
  'math': 'Maths',
  'coding': 'Coding',
  'art': 'Art',
  'crafts': 'Crafts',
  'music': 'Music',
  'history': 'History',
  'chess': 'Chess',
  'sports': 'Sports',
  'cooking': 'Cooking',
  'comedy': 'Comedy',
  'animation': 'Animation',
  'lego': 'Lego',
  'parkour': 'Parkour',
  'reading': 'Reading & Stories',
  'languages': 'Languages',
  'geography': 'Geography',
  'yoga-mindfulness': 'Yoga & Mindfulness',
  'puzzles': 'Puzzles',
  'magic': 'Magic',
  'vehicles': 'Vehicles',
  'robots': 'Robots',
  'dance': 'Dance',
};

// ---- State ----

let currentKids = [];
let selectedKidId = null;
let pollingTimer = null;

// ---- Utilities ----

function $(id) { return document.getElementById(id); }

function showScreen(id) {
  for (const el of document.querySelectorAll('.screen')) {
    el.classList.add('hidden');
  }
  const target = $(id);
  if (target) target.classList.remove('hidden');
}

function showError(elId, msg) {
  const el = $(elId);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearError(elId) {
  const el = $(elId);
  if (!el) return;
  el.textContent = '';
  el.classList.add('hidden');
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function makeEl(tag, { className, textContent, style } = {}) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (textContent !== undefined) el.textContent = textContent;
  if (style) el.style.cssText = style;
  return el;
}

function makeSpinner(message) {
  const wrapper = makeEl('div', { className: 'generating-spinner' });
  wrapper.appendChild(makeEl('div', { className: 'spinner' }));
  wrapper.appendChild(makeEl('p', { textContent: message }));
  return wrapper;
}

// ---- Interest pills ----

function renderInterestPills() {
  const container = $('interest-pills');
  if (!container) return;
  container.textContent = '';
  for (const interest of AVAILABLE_INTERESTS) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'interest-pill';
    pill.dataset.interest = interest;
    pill.textContent = INTEREST_LABELS[interest] ?? interest;
    pill.addEventListener('click', () => {
      pill.classList.toggle('selected');
    });
    container.appendChild(pill);
  }
}

function getSelectedInterests() {
  const pills = document.querySelectorAll('#interest-pills .interest-pill.selected');
  const fromPills = [...pills].map(p => p.dataset.interest);
  const custom = ($('add-kid-interests-custom')?.value ?? '').trim();
  const fromCustom = custom ? custom.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];
  return [...fromPills, ...fromCustom];
}

function clearInterestPills() {
  for (const pill of document.querySelectorAll('#interest-pills .interest-pill.selected')) {
    pill.classList.remove('selected');
  }
  const custom = $('add-kid-interests-custom');
  if (custom) custom.value = '';
}

// ---- Auth ----

async function checkSession() {
  try {
    const res = await fetch('/api/auth/session');
    const data = await res.json();
    if (data.authenticated) {
      await loadDashboard();
    } else {
      showScreen('auth-screen');
    }
  } catch {
    showScreen('auth-screen');
  }
}

async function handleSignup(e) {
  e.preventDefault();
  clearError('signup-error');
  const email = $('signup-email').value.trim();
  const password = $('signup-password').value;
  if (!email || !password) return;

  try {
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (res.status === 409) {
      showError('signup-error', 'That email is already registered. Try logging in.');
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showError('signup-error', data.error || 'Signup failed. Please try again.');
      return;
    }
    await loadDashboard();
  } catch {
    showError('signup-error', 'Network error. Please try again.');
  }
}

async function handleLogin(e) {
  e.preventDefault();
  clearError('login-error');
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  if (!email || !password) return;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (res.status === 401) {
      showError('login-error', 'Incorrect email or password.');
      return;
    }
    if (!res.ok) {
      showError('login-error', 'Login failed. Please try again.');
      return;
    }
    await loadDashboard();
  } catch {
    showError('login-error', 'Network error. Please try again.');
  }
}

async function handleLogout() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  stopPolling();
  currentKids = [];
  selectedKidId = null;
  showScreen('auth-screen');
  showForm('signup');
}

// ---- Auth form toggle ----

function showForm(which) {
  const signupForm = $('signup-form');
  const loginForm = $('login-form');
  if (which === 'signup') {
    signupForm.classList.remove('hidden');
    loginForm.classList.add('hidden');
  } else {
    loginForm.classList.remove('hidden');
    signupForm.classList.add('hidden');
  }
}

// ---- Dashboard ----

async function loadDashboard() {
  stopPolling();
  showScreen('dashboard-screen');
  hideAddKidForm();
  await loadKids();
}

async function loadKids() {
  const container = $('kid-list');
  container.textContent = '';
  const loading = makeEl('p', { className: 'loading-inline', textContent: 'Loading...' });
  container.appendChild(loading);

  try {
    const res = await fetch('/api/kids');
    if (!res.ok) throw new Error('Failed to load kids');
    currentKids = await res.json();
    renderKidList();
  } catch {
    container.textContent = '';
    const err = makeEl('p', { className: 'loading-inline', textContent: 'Failed to load children.' });
    container.appendChild(err);
  }
}

function renderKidList() {
  const container = $('kid-list');
  container.textContent = '';

  if (currentKids.length === 0) {
    const emptyMsg = makeEl('p', { className: 'empty-state', textContent: 'Add your first child to get started.' });
    container.appendChild(emptyMsg);
    return;
  }

  for (const kid of currentKids) {
    const card = makeEl('div', { className: 'kid-card' });
    card.dataset.kidId = kid.id;
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');

    card.appendChild(makeEl('div', { className: 'kid-card-name', textContent: kid.name }));
    card.appendChild(makeEl('div', { className: 'kid-card-meta', textContent: kid.age ? `Age ${kid.age}` : 'Age not set' }));

    card.addEventListener('click', () => openKidDetail(kid.id));
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') openKidDetail(kid.id);
    });

    container.appendChild(card);
  }
}

// ---- Add kid form ----

function showAddKidForm() {
  $('add-kid-form').classList.remove('hidden');
  $('add-kid-name').focus();
}

function hideAddKidForm() {
  $('add-kid-form').classList.add('hidden');
  $('add-kid-form-el').reset();
  clearInterestPills();
  clearError('add-kid-error');
}

async function handleAddKid(e) {
  e.preventDefault();
  clearError('add-kid-error');

  const name = $('add-kid-name').value.trim();
  const age = $('add-kid-age').value ? parseInt($('add-kid-age').value, 10) : null;
  const guidelines = $('add-kid-guidelines').value.trim() || null;

  if (!name) {
    showError('add-kid-error', 'Name is required.');
    return;
  }

  const selectedInterests = getSelectedInterests();
  const interests = selectedInterests.length > 0 ? selectedInterests : null;

  try {
    const res = await fetch('/api/kids', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, age, interests, guidelines }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showError('add-kid-error', data.error || 'Failed to add child.');
      return;
    }
    const newKid = await res.json();
    hideAddKidForm();
    // Add to local state and navigate straight to the detail view so
    // the parent can see and act on channel suggestions immediately.
    currentKids = [...currentKids, newKid];
    await openKidDetail(newKid.id);
  } catch {
    showError('add-kid-error', 'Network error. Please try again.');
  }
}

// ---- Kid detail ----

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

async function openKidDetail(kidId) {
  stopPolling();
  selectedKidId = kidId;
  const kid = currentKids.find(k => k.id === kidId);
  if (!kid) return;

  showScreen('detail-screen');

  // Show loading state while detail loads
  $('detail-kid-name').textContent = kid.name;
  $('detail-kid-meta').textContent = kid.age ? `Age ${kid.age}` : 'Age not set';

  // Clear dynamic sections while loading
  $('detail-status-section').textContent = '';
  $('suggestions-area').textContent = '';
  $('feed-preview-section').textContent = '';
  $('channel-list').textContent = '';
  $('guidelines-section').textContent = '';

  const loadingLi = makeEl('li', { className: 'loading-inline', textContent: 'Loading...' });
  $('channel-list').appendChild(loadingLi);

  renderSetupLinkSection(kid);
  renderStatusSection(kid);

  await renderSuggestionsArea(kid);
  await renderFeedPreview(kidId);

  renderGuidelinesSection(kid);
  renderAddChannelRow(kidId);
  await loadChannelList(kidId);
}

// ---- Status section ----

function renderStatusSection(kid) {
  const section = $('detail-status-section');
  section.textContent = '';

  const statusCard = makeEl('div', { className: 'status-bar detail-card' });

  // Last updated with indicator dot
  const lastUpdatedWrap = makeEl('div', { className: 'status-item' });
  const dot = makeEl('span', { className: 'status-dot' });

  let dotClass = 'dot-grey';
  let lastUpdatedText = 'Never updated';

  if (kid.last_pushed_at) {
    const updatedAt = new Date(kid.last_pushed_at + 'Z');
    const ageMs = Date.now() - updatedAt.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);

    if (ageHours < 1) {
      dotClass = 'dot-green';
    } else if (ageHours < 24) {
      dotClass = 'dot-yellow';
    } else {
      dotClass = 'dot-grey';
    }

    // Format relative time
    if (ageHours < 1) {
      const mins = Math.floor(ageMs / 60000);
      lastUpdatedText = `Updated ${mins < 2 ? 'just now' : mins + ' mins ago'}`;
    } else if (ageHours < 24) {
      lastUpdatedText = `Updated ${Math.floor(ageHours)}h ago`;
    } else {
      const days = Math.floor(ageHours / 24);
      lastUpdatedText = `Updated ${days}d ago`;
    }
  }

  dot.classList.add('status-dot', dotClass);
  lastUpdatedWrap.appendChild(dot);
  lastUpdatedWrap.appendChild(makeEl('span', { textContent: lastUpdatedText }));
  statusCard.appendChild(lastUpdatedWrap);

  section.appendChild(statusCard);
}

// ---- Guidelines section ----

function renderGuidelinesSection(kid) {
  const section = $('guidelines-section');
  section.textContent = '';

  const card = makeEl('div', { className: 'detail-card guidelines-card' });
  card.appendChild(makeEl('h3', { textContent: 'Content guidelines' }));

  const hint = makeEl('p', { className: 'hint', textContent: 'Content guidelines for ' + kid.name + '\'s feed. Videos from their channels are filtered before appearing.' });
  card.appendChild(hint);

  const textarea = document.createElement('textarea');
  textarea.value = kid.guidelines || '';
  textarea.placeholder = 'e.g. No scary content. Educational channels are great. Nothing about violence or weapons.';
  textarea.rows = 4;

  const savedMsg = makeEl('span', { className: 'saved-indicator hidden', textContent: 'Saved' });

  textarea.addEventListener('blur', async () => {
    const newVal = textarea.value.trim();
    try {
      await fetch(`/api/kids/${kid.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guidelines: newVal }),
      });
      // Update in local state
      const localKid = currentKids.find(k => k.id === kid.id);
      if (localKid) localKid.guidelines = newVal;
      savedMsg.classList.remove('hidden');
      setTimeout(() => savedMsg.classList.add('hidden'), 2000);
    } catch { /* silently ignore */ }
  });

  card.appendChild(textarea);
  card.appendChild(savedMsg);
  section.appendChild(card);
}

// ---- Setup link section ----

function renderSetupLinkSection(kid) {
  $('setup-link-url').textContent = kid.setup_token;
  $('setup-link-url').dataset.url = kid.setup_token;
  $('setup-link-kid-id').value = kid.id;
}

// ---- Suggestions ----

async function renderSuggestionsArea(kid) {
  const area = $('suggestions-area');
  area.textContent = '';

  const status = kid.channels_status;

  if (status === 'generating') {
    // Parse interests to show which ones we're searching for
    let interestList = [];
    try { interestList = kid.interests ? JSON.parse(kid.interests) : []; } catch { /* ignore */ }
    // Custom interests are ones not in the standard pill set
    const customInterests = interestList.filter(i => !AVAILABLE_INTERESTS.includes(i));
    let hintText;
    if (customInterests.length > 0) {
      const formatted = customInterests.map(i => `"${i}"`).join(', ');
      hintText = `We're searching for YouTube channels about ${formatted} for ${kid.name}. This takes about a minute. You'll review every channel before it goes live.`;
    } else {
      hintText = `We're finding YouTube channels that match ${kid.name}'s interests. This takes about a minute. You'll review every channel before it goes live.`;
    }
    const hint = makeEl('p', { className: 'onboarding-hint', textContent: hintText });
    area.appendChild(hint);
    const spinnerText = customInterests.length > 0
      ? `Searching for ${customInterests.join(', ')} channels...`
      : `Finding channels for ${kid.name}...`;
    area.appendChild(makeSpinner(spinnerText));
    startStatusPolling(kid, 'generating');
    return;
  }

  if (status === 'reviewing') {
    const hint = makeEl('p', { className: 'onboarding-hint', textContent: `Checking channel suggestions against your content preferences for ${kid.name}. This takes about a minute.` });
    area.appendChild(hint);
    area.appendChild(makeSpinner(`Reviewing channels for ${kid.name}...`));
    startStatusPolling(kid, 'reviewing');
    return;
  }

  if (status === 'refining') {
    area.appendChild(makeSpinner(`Refining suggestions for ${kid.name}...`));
    startStatusPolling(kid, 'refining');
    return;
  }

  // 'ready' or 'idle': check for pending suggestions
  if (status === 'ready' || status === 'idle') {
    try {
      const res = await fetch(`/api/kids/${kid.id}/suggestions`);
      if (res.ok) {
        const data = await res.json();
        if (data.suggestions && data.suggestions.length > 0) {
          renderSuggestionCards(area, kid, data.suggestions);
          return;
        }
      }
    } catch { /* fall through */ }
  }

  // No pending suggestions — show feedback input so parent can request more
  renderFeedbackSection(area, kid);
}

let lastRenderedStatus = null;

function startStatusPolling(kid, awaitedStatus) {
  stopPolling(); // clear any existing poll first
  lastRenderedStatus = awaitedStatus;
  pollingTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/kids');
      if (!res.ok) return;
      const kids = await res.json();
      const updated = kids.find(k => k.id === kid.id);
      if (!updated) return;
      if (updated.channels_status !== awaitedStatus) {
        stopPolling();
        currentKids = kids;
        // Only re-render if status actually changed from what we last rendered
        if (updated.channels_status === lastRenderedStatus) return;
        lastRenderedStatus = updated.channels_status;
        Object.assign(kid, updated);
        await renderSuggestionsArea(updated);
        await loadChannelList(updated.id);
      }
    } catch { /* ignore, will retry */ }
  }, 3000);
}

function renderSuggestionCards(area, kid, suggestions) {
  const section = makeEl('div', { className: 'suggestions-section' });

  // Header row: title block + approve all button
  const header = makeEl('div', { className: 'suggestions-header' });

  const titleBlock = makeEl('div');
  titleBlock.appendChild(makeEl('h3', { textContent: `Channel suggestions for ${kid.name}` }));
  const hint = makeEl('p', { className: 'hint', textContent: `These channels were suggested based on ${kid.name}'s interests. Approve the ones you like, skip the rest. You can always add more later or ask for different suggestions.` });
  titleBlock.appendChild(hint);

  const approveAllBtn = makeEl('button', { className: 'btn btn-primary', textContent: 'Approve all', style: 'width:auto' });

  header.appendChild(titleBlock);
  header.appendChild(approveAllBtn);
  section.appendChild(header);

  const list = makeEl('div', { className: 'suggestion-list' });
  section.appendChild(list);
  area.appendChild(section);

  for (const suggestion of suggestions) {
    list.appendChild(makeSuggestionCard(kid, suggestion, list, area));
  }

  approveAllBtn.addEventListener('click', async () => {
    approveAllBtn.disabled = true;
    approveAllBtn.textContent = 'Approving...';
    const cards = [...list.querySelectorAll('.suggestion-card')];
    for (const card of cards) {
      const channelId = card.dataset.channelId;
      try {
        await fetch(`/api/kids/${kid.id}/channels/${encodeURIComponent(channelId)}/approve`, { method: 'POST' });
      } catch { /* ignore */ }
      card.remove();
    }
    await afterAllSuggestionsProcessed(area, kid);
  });

  // Feedback section below cards
  const feedbackContainer = makeEl('div');
  area.appendChild(feedbackContainer);
  renderFeedbackSection(feedbackContainer, kid);
}

function makeSuggestionCard(kid, suggestion, list, area) {
  const card = makeEl('div', { className: 'suggestion-card' });
  card.dataset.channelId = suggestion.channel_id;

  const info = makeEl('div', { className: 'suggestion-info' });
  const titleRow = makeEl('div', { className: 'suggestion-title-row' });
  titleRow.appendChild(makeEl('strong', { textContent: suggestion.title }));
  const ytLink = document.createElement('a');
  ytLink.href = `https://www.youtube.com/channel/${suggestion.channel_id}`;
  ytLink.target = '_blank';
  ytLink.rel = 'noopener';
  ytLink.textContent = 'View on YouTube';
  ytLink.className = 'suggestion-yt-link';
  titleRow.appendChild(ytLink);
  info.appendChild(titleRow);
  info.appendChild(makeEl('p', { className: 'suggestion-reason', textContent: suggestion.reason || '' }));

  const actions = makeEl('div', { className: 'suggestion-actions' });
  const approveBtn = makeEl('button', { className: 'btn btn-approve', textContent: 'Approve' });
  const skipBtn = makeEl('button', { className: 'btn btn-skip', textContent: 'Skip' });
  actions.appendChild(approveBtn);
  actions.appendChild(skipBtn);

  card.appendChild(info);
  card.appendChild(actions);

  approveBtn.addEventListener('click', async () => {
    approveBtn.disabled = true;
    skipBtn.disabled = true;
    try {
      await fetch(`/api/kids/${kid.id}/channels/${encodeURIComponent(suggestion.channel_id)}/approve`, { method: 'POST' });
    } catch { /* ignore */ }
    card.remove();
    await onSuggestionProcessed(list, area, kid);
  });

  skipBtn.addEventListener('click', async () => {
    approveBtn.disabled = true;
    skipBtn.disabled = true;
    try {
      await fetch(`/api/kids/${kid.id}/channels/${encodeURIComponent(suggestion.channel_id)}/reject`, { method: 'POST' });
    } catch { /* ignore */ }
    card.remove();
    await onSuggestionProcessed(list, area, kid);
  });

  return card;
}

async function onSuggestionProcessed(list, area, kid) {
  await loadChannelList(kid.id);
  if (list.children.length === 0) {
    await afterAllSuggestionsProcessed(area, kid);
  }
}

async function afterAllSuggestionsProcessed(area, kid) {
  try {
    const res = await fetch('/api/kids');
    if (res.ok) currentKids = await res.json();
  } catch { /* ignore */ }
  await openKidDetail(kid.id);
}

function renderFeedbackSection(container, kid) {
  const section = makeEl('div', { className: 'feedback-section' });
  section.appendChild(makeEl('h3', { textContent: 'Refine suggestions' }));

  const row = makeEl('div', { className: 'feedback-row' });
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'feedback-input';
  input.placeholder = 'e.g. More educational science, he also loves chess';

  const btn = makeEl('button', { className: 'btn btn-secondary', textContent: 'Send' });

  row.appendChild(input);
  row.appendChild(btn);
  section.appendChild(row);
  container.appendChild(section);

  const submit = async () => {
    const message = input.value.trim();
    if (!message) return;
    btn.disabled = true;
    btn.textContent = 'Sending...';
    try {
      await fetch(`/api/kids/${kid.id}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      input.value = '';
      const res = await fetch('/api/kids');
      if (res.ok) currentKids = await res.json();
      const updatedKid = currentKids.find(k => k.id === kid.id);
      if (updatedKid) await openKidDetail(updatedKid.id);
    } catch {
      btn.disabled = false;
      btn.textContent = 'Send';
    }
  };

  btn.addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

// ---- Channel list ----

async function loadChannelList(kidId) {
  const list = $('channel-list');
  list.textContent = '';

  const li = makeEl('li', { className: 'loading-inline', textContent: 'Loading channels...' });
  list.appendChild(li);

  try {
    const res = await fetch(`/api/kids/${kidId}/channels`);
    if (!res.ok) throw new Error('Failed to load channels');
    const channels = await res.json();
    renderChannels(kidId, channels);
    return channels;
  } catch {
    list.textContent = '';
    const li2 = makeEl('li', { className: 'loading-inline', textContent: 'Failed to load channels.' });
    list.appendChild(li2);
    return [];
  }
}

function renderChannels(kidId, channels) {
  const list = $('channel-list');
  list.textContent = '';

  // Only show approved channels
  const approved = channels.filter(ch => ch.status === 'approved');

  if (approved.length === 0) {
    list.appendChild(makeEl('li', { className: 'empty-channels', textContent: 'Channels will appear here once suggestions are generated.' }));
    return;
  }

  for (const ch of approved) {
    const li = makeEl('li', { className: 'channel-item' });

    const nameWrap = makeEl('span', { className: 'channel-name-wrap' });
    nameWrap.appendChild(makeEl('span', { className: 'channel-name', textContent: ch.title }));
    const ytLink = document.createElement('a');
    ytLink.href = `https://www.youtube.com/channel/${ch.channel_id}`;
    ytLink.target = '_blank';
    ytLink.rel = 'noopener';
    ytLink.textContent = 'View';
    ytLink.className = 'channel-yt-link';
    nameWrap.appendChild(ytLink);
    li.appendChild(nameWrap);

    const removeBtn = makeEl('button', { className: 'btn btn-danger', textContent: 'Remove' });
    removeBtn.addEventListener('click', () => removeChannel(kidId, ch.channel_id));
    li.appendChild(removeBtn);

    list.appendChild(li);
  }
}

async function removeChannel(kidId, channelId) {
  try {
    const res = await fetch(`/api/kids/${kidId}/channels/${encodeURIComponent(channelId)}/unapprove`, {
      method: 'POST',
    });
    if (!res.ok) return;
    await loadChannelList(kidId);
  } catch {
    // silently ignore
  }
}

// ---- Add channel row ----

function renderAddChannelRow(kidId) {
  const row = $('add-channel-row');
  if (!row) return;
  row.textContent = '';

  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'add-channel-input';
  input.placeholder = 'Channel name or YouTube URL';

  const btn = makeEl('button', { className: 'btn btn-secondary', textContent: 'Add', style: 'white-space:nowrap' });

  row.appendChild(input);
  row.appendChild(btn);

  const submit = async () => {
    const val = input.value.trim();
    if (!val) return;
    btn.disabled = true;
    btn.textContent = 'Adding...';
    try {
      const res = await fetch(`/api/kids/${kidId}/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_id: val, title: val }),
      });
      if (res.ok) {
        input.value = '';
        await loadChannelList(kidId);
      }
    } catch { /* silently ignore */ }
    btn.disabled = false;
    btn.textContent = 'Add';
  };

  btn.addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

// ---- Recent videos ----

async function renderRecentVideos(kidId, approvedChannelCount = 0) {
  const section = $('recent-videos-section');
  section.textContent = '';

  const card = makeEl('div', { className: 'detail-card recent-videos-card' });
  card.appendChild(makeEl('h3', { textContent: 'Recent videos' }));

  try {
    const res = await fetch(`/api/kids/${kidId}/recent-videos`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    const videos = data.videos ?? [];
    const hasApprovedVideos = videos.some(v => v.ai_approved);
    const reviewPending = approvedChannelCount > 0 && !hasApprovedVideos;

    if (reviewPending) {
      card.appendChild(makeEl('p', { className: 'empty-state', textContent: 'Videos are being reviewed and will appear shortly. This usually takes a couple of minutes.' }));
    } else if (videos.length === 0) {
      card.appendChild(makeEl('p', { className: 'empty-state', textContent: 'Videos will appear after channels are added and the feed updates (every 30 minutes).' }));
    }

    if (videos.length > 0) {
      const list = makeEl('ul', { className: 'video-list' });
      for (const v of videos) {
        const li = makeEl('li', { className: 'video-item' });

        if (v.thumbnail) {
          const img = document.createElement('img');
          img.src = v.thumbnail;
          img.className = 'video-thumb';
          img.alt = '';
          li.appendChild(img);
        }

        const info = makeEl('div', { className: 'video-info' });
        info.appendChild(makeEl('span', { className: 'video-title', textContent: v.title }));
        info.appendChild(makeEl('span', { className: 'video-channel', textContent: v.channel_title }));
        li.appendChild(info);

        const badge = makeEl('span', {
          className: v.ai_approved ? 'video-badge badge-approved' : 'video-badge badge-rejected',
          textContent: v.ai_approved ? 'Included' : 'Filtered out',
        });
        li.appendChild(badge);

        list.appendChild(li);
      }
      card.appendChild(list);
    }
  } catch {
    card.appendChild(makeEl('p', { className: 'loading-inline', textContent: 'Failed to load recent videos.' }));
  }

  section.appendChild(card);
}

// ---- Feed preview with parent ratings ----

async function renderFeedPreview(kidId) {
  const section = $('feed-preview-section');
  section.textContent = '';

  const card = makeEl('div', { className: 'detail-card feed-preview-card' });
  card.appendChild(makeEl('h3', { textContent: 'Feed preview' }));
  card.appendChild(makeEl('p', { className: 'hint', textContent: 'Videos currently in this child\'s feed. Rate them to refine what they see.' }));

  try {
    const res = await fetch(`/api/kids/${kidId}/feed-preview`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    const videos = data.videos ?? [];
    const ratings = data.parent_ratings ?? {};

    if (videos.length === 0) {
      card.appendChild(makeEl('p', { className: 'empty-state', textContent: 'No videos in the feed yet.' }));
      section.appendChild(card);
      return;
    }

    const grid = makeEl('div', { className: 'feed-preview-grid' });

    for (const v of videos) {
      const videoCard = makeEl('div', { className: 'feed-video-card' });
      videoCard.dataset.videoId = v.video_id;
      videoCard.dataset.channelId = v.channel_id;

      if (v.thumbnail) {
        const img = document.createElement('img');
        img.src = v.thumbnail;
        img.alt = '';
        videoCard.appendChild(img);
      } else {
        // Placeholder thumbnail using YouTube's default
        const img = document.createElement('img');
        img.src = `https://img.youtube.com/vi/${encodeURIComponent(v.video_id)}/mqdefault.jpg`;
        img.alt = '';
        videoCard.appendChild(img);
      }

      const body = makeEl('div', { className: 'feed-video-card-body' });
      body.appendChild(makeEl('div', { className: 'feed-video-card-title', textContent: v.title }));
      body.appendChild(makeEl('div', { className: 'feed-video-card-channel', textContent: v.channel_title }));
      videoCard.appendChild(body);

      const actions = makeEl('div', { className: 'feed-video-card-actions' });

      const thumbUp = document.createElement('button');
      thumbUp.type = 'button';
      thumbUp.className = 'btn-thumb';
      thumbUp.textContent = '\u{1F44D}';
      thumbUp.title = 'Keep in feed';
      if (ratings[v.video_id] === 1) {
        thumbUp.classList.add('thumb-active-up');
      }

      const thumbDown = document.createElement('button');
      thumbDown.type = 'button';
      thumbDown.className = 'btn-thumb';
      thumbDown.textContent = '\u{1F44E}';
      thumbDown.title = 'Remove from feed';
      if (ratings[v.video_id] === -1) {
        thumbDown.classList.add('thumb-active-down');
      }

      thumbUp.addEventListener('click', async () => {
        thumbUp.disabled = true;
        thumbDown.disabled = true;
        try {
          await fetch(`/api/kids/${kidId}/rate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ video_id: v.video_id, rating: 1 }),
          });
          thumbUp.classList.add('thumb-active-up');
          thumbDown.classList.remove('thumb-active-down');
        } catch { /* ignore */ }
        thumbUp.disabled = false;
        thumbDown.disabled = false;
      });

      thumbDown.addEventListener('click', async () => {
        thumbUp.disabled = true;
        thumbDown.disabled = true;
        try {
          await fetch(`/api/kids/${kidId}/rate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ video_id: v.video_id, rating: -1 }),
          });
          showRemoveChannelPrompt(videoCard, kidId, v.channel_id, v.channel_title, grid, card);
        } catch {
          thumbUp.disabled = false;
          thumbDown.disabled = false;
        }
      });

      actions.appendChild(thumbUp);
      actions.appendChild(thumbDown);
      videoCard.appendChild(actions);

      grid.appendChild(videoCard);
    }

    card.appendChild(grid);
  } catch {
    card.appendChild(makeEl('p', { className: 'loading-inline', textContent: 'Failed to load feed preview.' }));
  }

  section.appendChild(card);
}

function showRemoveChannelPrompt(videoCard, kidId, channelId, channelTitle, grid, feedCard) {
  const overlay = makeEl('div', { className: 'remove-channel-overlay' });
  overlay.appendChild(makeEl('span', { className: 'remove-channel-overlay-dismissed', textContent: '👎 Removed' }));
  overlay.appendChild(makeEl('span', { className: 'remove-channel-overlay-name', textContent: channelTitle }));

  const removeBtn = makeEl('button', {
    className: 'btn-remove-channel',
    textContent: 'Remove all from this channel',
  });
  overlay.appendChild(removeBtn);

  const countdown = makeEl('div', { className: 'remove-countdown' });
  countdown.appendChild(makeEl('div', { className: 'remove-countdown-bar' }));
  overlay.appendChild(countdown);

  videoCard.appendChild(overlay);

  const dismissCard = () => {
    videoCard.classList.add('fading-out');
    videoCard.addEventListener('transitionend', () => {
      videoCard.remove();
      if (grid.children.length === 0) {
        grid.remove();
        feedCard.appendChild(makeEl('p', { className: 'empty-state', textContent: 'No videos in the feed.' }));
      }
    }, { once: true });
  };

  const timer = setTimeout(dismissCard, 5000);

  removeBtn.addEventListener('click', () => {
    clearTimeout(timer);
    removeChannelFromFeed(kidId, channelId, grid, feedCard);
  });
}

async function removeChannelFromFeed(kidId, channelId, grid, feedCard) {
  // Fade all visible cards from this channel simultaneously
  const channelCards = [...grid.querySelectorAll(`[data-channel-id="${CSS.escape(channelId)}"]`)];
  channelCards.forEach(c => c.classList.add('fading-out'));

  try {
    await fetch(`/api/kids/${kidId}/channels/${encodeURIComponent(channelId)}/unapprove`, { method: 'POST' });
  } catch { /* best-effort */ }

  setTimeout(() => {
    channelCards.forEach(c => c.remove());
    if (grid.children.length === 0) {
      grid.remove();
      feedCard.appendChild(makeEl('p', { className: 'empty-state', textContent: 'No videos in the feed.' }));
    }
    // Refresh the channel list so the removed channel disappears there too
    loadChannelList(kidId);
  }, 300);
}

// ---- Copy to clipboard ----

async function copySetupLink() {
  const url = $('setup-link-url').dataset.url;
  try {
    await navigator.clipboard.writeText(url);
    const btn = $('copy-setup-link-btn');
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  } catch {
    // Clipboard API unavailable — nothing to do
  }
}

// ---- Regenerate setup token ----

async function regenerateSetupToken() {
  const kidId = $('setup-link-kid-id').value;
  if (!kidId) return;
  const btn = $('regen-token-btn');
  btn.disabled = true;
  btn.textContent = 'Regenerating...';
  try {
    const res = await fetch(`/api/kids/${kidId}/regenerate-token`, { method: 'POST' });
    if (!res.ok) throw new Error();
    // Refresh kid detail to show new link
    const kidsRes = await fetch('/api/kids');
    if (kidsRes.ok) currentKids = await kidsRes.json();
    await openKidDetail(kidId);
  } catch {
    btn.disabled = false;
    btn.textContent = 'Regenerate link';
  }
}

// ---- Revoke all devices ----

async function revokeAllDevices() {
  const kidId = $('setup-link-kid-id').value;
  if (!kidId) return;
  const btn = $('revoke-devices-btn');
  btn.disabled = true;
  btn.textContent = 'Revoking...';
  try {
    const res = await fetch(`/api/kids/${kidId}/revoke`, { method: 'POST' });
    if (!res.ok) throw new Error();
    btn.textContent = 'Revoked';
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = 'Revoke all devices';
    }, 2000);
  } catch {
    btn.disabled = false;
    btn.textContent = 'Revoke all devices';
  }
}

// ---- Event wiring ----

document.addEventListener('DOMContentLoaded', () => {
  $('signup-form').addEventListener('submit', handleSignup);
  $('login-form').addEventListener('submit', handleLogin);
  $('show-login-btn').addEventListener('click', () => showForm('login'));
  $('show-signup-btn').addEventListener('click', () => showForm('signup'));
  $('logout-btn').addEventListener('click', handleLogout);

  $('add-kid-btn').addEventListener('click', showAddKidForm);
  $('add-kid-form-el').addEventListener('submit', handleAddKid);
  $('cancel-add-kid-btn').addEventListener('click', hideAddKidForm);

  renderInterestPills();

  $('back-to-dashboard-btn').addEventListener('click', () => {
    stopPolling();
    selectedKidId = null;
    loadDashboard();
  });

  $('copy-setup-link-btn').addEventListener('click', copySetupLink);
  $('regen-token-btn').addEventListener('click', regenerateSetupToken);
  $('revoke-devices-btn').addEventListener('click', revokeAllDevices);

  checkSession();
});
