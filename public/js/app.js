import { openPlayer, closePlayer } from './player.js';

// State
let currentChannel = 'all';
let allVideos = [];
let channels = [];
export let likedVideoIds = new Set();
let searchMode = false;
let searchVideos = [];
let searchDebounceTimer = null;
let currentUsername = null;
let kidcodeConfig = { enabled: false, url: '' };

// DOM elements
const loginScreen = document.getElementById('login-screen');
const feedScreen = document.getElementById('feed-screen');
const loginForm = document.getElementById('login-form');
const usernameInput = document.getElementById('username-input');
const passwordInput = document.getElementById('password-input');
const loginError = document.getElementById('login-error');
const channelTabs = document.getElementById('channel-tabs');
const videoGrid = document.getElementById('video-grid');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const emptyEl = document.getElementById('empty');
const logoutBtn = document.getElementById('logout-btn');
const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');

// Heart SVG templates (reused for card like buttons)
const HEART_OUTLINE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
const HEART_FILLED = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';

// Channel tab click — event delegation
channelTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  const channel = btn.dataset.channel;
  if (channel === currentChannel) return;
  currentChannel = channel;
  channelTabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  renderGrid(currentChannel);
});

// Login form handler
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!username || !password) return;

  const btn = loginForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  loginError.classList.add('hidden');

  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) {
      const data = await res.json();
      currentUsername = data.username;
      kidcodeConfig = { enabled: !!data.kidcodeEnabled, url: data.kidcodeUrl || '' };
      usernameInput.value = '';
      passwordInput.value = '';
      await showFeed();
    } else {
      loginError.textContent = 'Wrong name or password — try again!';
      loginError.classList.remove('hidden');
      passwordInput.select();
    }
  } catch {
    loginError.textContent = 'Something went wrong — try again!';
    loginError.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

// Logout
logoutBtn.addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  showLogin();
});

// Retry on error tap
errorEl.addEventListener('click', () => loadFeed());

// ── Search ──

searchInput.addEventListener('input', () => {
  const query = searchInput.value.trim();
  searchClear.classList.toggle('hidden', !query);

  clearTimeout(searchDebounceTimer);
  if (!query) {
    exitSearchMode();
    return;
  }
  searchDebounceTimer = setTimeout(() => doSearch(query), 500);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(searchDebounceTimer);
    const query = searchInput.value.trim();
    if (query) doSearch(query);
  }
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.classList.add('hidden');
  exitSearchMode();
  searchInput.focus();
});

async function doSearch(query) {
  enterSearchMode();
  showLoading(true);
  errorEl.classList.add('hidden');

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    if (res.status === 401) {
      showLogin();
      return;
    }
    const data = await res.json();
    searchVideos = data.videos || [];
    if (data.likedVideoIds) {
      likedVideoIds = new Set(data.likedVideoIds);
    }

    videoGrid.innerHTML = '';
    if (data.message) {
      const msg = document.createElement('div');
      msg.className = 'search-message';
      msg.textContent = data.message;
      videoGrid.appendChild(msg);
    }

    if (searchVideos.length === 0 && !data.message) {
      emptyEl.textContent = 'No results found. Try a different search!';
      emptyEl.classList.remove('hidden');
    } else {
      emptyEl.classList.add('hidden');
      for (const video of searchVideos) {
        videoGrid.appendChild(createCard(video));
      }
    }
  } catch {
    videoGrid.innerHTML = '';
    errorEl.classList.remove('hidden');
  } finally {
    showLoading(false);
  }
}

function enterSearchMode() {
  searchMode = true;
  channelTabs.classList.add('hidden');
}

function exitSearchMode() {
  searchMode = false;
  channelTabs.classList.remove('hidden');
  emptyEl.textContent = 'No videos yet. Ask a parent to add some channels!';
  renderGrid(currentChannel);
}

// ── Like ──

export async function toggleLike(video) {
  const videoId = video.videoId;
  const wasLiked = likedVideoIds.has(videoId);

  // Optimistic toggle
  if (wasLiked) {
    likedVideoIds.delete(videoId);
  } else {
    likedVideoIds.add(videoId);
  }
  updateLikeButtons(videoId);

  try {
    const res = await fetch('/api/likes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId,
        title: video.title || '',
        channelTitle: video.channelTitle || '',
        channelId: video.channelId || '',
      }),
    });
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();
    // Reconcile with server state
    if (data.liked) {
      likedVideoIds.add(videoId);
    } else {
      likedVideoIds.delete(videoId);
    }
  } catch {
    // Revert on failure
    if (wasLiked) {
      likedVideoIds.add(videoId);
    } else {
      likedVideoIds.delete(videoId);
    }
  }
  updateLikeButtons(videoId);
}

function updateLikeButtons(videoId) {
  const liked = likedVideoIds.has(videoId);

  // Update card buttons
  const cards = videoGrid.querySelectorAll(`.video-card[data-video-id="${videoId}"] .btn-like`);
  for (const btn of cards) {
    btn.classList.toggle('liked', liked);
  }

  // Update player button
  const playerBtn = document.getElementById('player-like-btn');
  if (playerBtn && playerBtn.dataset.videoId === videoId) {
    playerBtn.classList.toggle('liked', liked);
    const outline = playerBtn.querySelector('.heart-outline');
    const filled = playerBtn.querySelector('.heart-filled');
    if (outline) outline.classList.toggle('hidden', liked);
    if (filled) filled.classList.toggle('hidden', !liked);
  }
}

// ── Screen transitions ──

function showLogin() {
  feedScreen.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  currentUsername = null;
  kidcodeConfig = { enabled: false, url: '' };
  document.getElementById('kidcode-link').classList.add('hidden');
  usernameInput.focus();
}

async function showFeed() {
  loginScreen.classList.add('hidden');
  feedScreen.classList.remove('hidden');
  currentChannel = 'all';
  searchInput.value = '';
  searchClear.classList.add('hidden');
  searchMode = false;
  channelTabs.classList.remove('hidden');
  // Show KidCode link if the server has cross-app integration enabled
  const kidcodeLink = document.getElementById('kidcode-link');
  if (kidcodeConfig.enabled && kidcodeConfig.url) {
    kidcodeLink.href = kidcodeConfig.url;
    kidcodeLink.classList.remove('hidden');
  } else {
    kidcodeLink.classList.add('hidden');
  }
  await loadFeed();
}

// ── Feed loading ──

async function loadFeed() {
  showLoading(true);
  errorEl.classList.add('hidden');
  try {
    const res = await fetch('/api/feed');
    if (res.status === 401) {
      showLogin();
      return;
    }
    const data = await res.json();
    allVideos = data.videos || [];
    channels = data.channels || [];
    if (data.likedVideoIds) {
      likedVideoIds = new Set(data.likedVideoIds);
    }
    buildChannelTabs();
    renderGrid(currentChannel);
  } catch {
    allVideos = [];
    channels = [];
    videoGrid.innerHTML = '';
    emptyEl.classList.add('hidden');
    errorEl.classList.remove('hidden');
  } finally {
    showLoading(false);
  }
}

function buildChannelTabs() {
  channelTabs.innerHTML = '<button class="tab active" data-channel="all">All</button>';
  for (const ch of channels) {
    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.dataset.channel = ch.channelId;
    btn.textContent = ch.title || ch.id;
    channelTabs.appendChild(btn);
  }
}

function renderGrid(channelId) {
  if (searchMode) return; // don't overwrite search results

  const videos = channelId === 'all'
    ? allVideos
    : allVideos.filter(v => v.channelId === channelId);

  videoGrid.innerHTML = '';

  if (videos.length === 0) {
    emptyEl.classList.remove('hidden');
    return;
  }

  emptyEl.classList.add('hidden');
  for (const video of videos) {
    videoGrid.appendChild(createCard(video));
  }
}

function createCard(video) {
  const card = document.createElement('div');
  card.className = 'video-card';
  card.dataset.videoId = video.videoId;

  if (video.thumbnail) {
    const img = document.createElement('img');
    img.className = 'video-thumb';
    img.src = video.thumbnail;
    img.alt = video.title || '';
    img.loading = 'lazy';
    img.onerror = () => {
      const placeholder = document.createElement('div');
      placeholder.className = 'video-thumb-placeholder';
      placeholder.textContent = '\u25B6';
      img.replaceWith(placeholder);
    };
    card.appendChild(img);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'video-thumb-placeholder';
    placeholder.textContent = '\u25B6';
    card.appendChild(placeholder);
  }

  const info = document.createElement('div');
  info.className = 'video-info';

  const title = document.createElement('div');
  title.className = 'video-title';
  title.textContent = video.title || 'Untitled';
  info.appendChild(title);

  if (video.channelTitle) {
    const channel = document.createElement('div');
    channel.className = 'video-channel';
    channel.textContent = video.channelTitle;
    info.appendChild(channel);
  }

  if (video.publishedAt) {
    const date = document.createElement('div');
    date.className = 'video-date';
    date.textContent = formatDate(video.publishedAt);
    info.appendChild(date);
  }

  // Like button
  const likeBtn = document.createElement('button');
  likeBtn.className = 'btn-like' + (likedVideoIds.has(video.videoId) ? ' liked' : '');
  likeBtn.setAttribute('aria-label', 'Like this video');
  likeBtn.innerHTML = `<span class="heart-outline">${HEART_OUTLINE}</span><span class="heart-filled">${HEART_FILLED}</span>`;
  likeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleLike(video);
  });
  info.appendChild(likeBtn);

  card.appendChild(info);
  card.addEventListener('click', () => openVideo(video));
  return card;
}

function openVideo(video) {
  openPlayer(video);
}

function showLoading(show) {
  if (show) {
    loadingEl.classList.remove('hidden');
    videoGrid.innerHTML = '';
    emptyEl.classList.add('hidden');
  } else {
    loadingEl.classList.add('hidden');
  }
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const days = Math.floor((now - d) / (1000 * 60 * 60 * 24));
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

// ── Init ──

async function init() {
  try {
    const res = await fetch('/api/session');
    const data = await res.json();
    if (data.authenticated && data.username) {
      currentUsername = data.username;
      kidcodeConfig = { enabled: !!data.kidcodeEnabled, url: data.kidcodeUrl || '' };
      await showFeed();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

init();
