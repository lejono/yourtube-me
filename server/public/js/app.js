/**
 * app.js — YourTube kid SPA
 * No login screen. The kid is identified by the yt_kid cookie set via /setup/:token.
 */

import { openPlayer, closePlayer } from './player.js';

const noAccessScreen = document.getElementById('no-access');
const feedScreen = document.getElementById('feed-screen');
const kidNameEl = document.getElementById('kid-name');
const channelTabsEl = document.getElementById('channel-tabs');
const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');
const videoGridEl = document.getElementById('video-grid');
const loadingEl = document.getElementById('loading');

let currentChannel = null;
let allChannels = [];
export let likedVideoIds = new Set();
let watchedVideoIds = new Set();
let searchMode = false;
let searchDebounceTimer = null;

// --- Init ---

async function init() {
  await loadFeed();
}

// --- Feed loading ---

async function loadFeed(channel) {
  currentChannel = channel ?? null;
  showLoading(true);

  let url = '/api/feed';
  if (channel) {
    url += `?channel=${encodeURIComponent(channel)}`;
  }

  let data;
  try {
    const res = await fetch(url, { credentials: 'include' });

    if (res.status === 404) {
      showNoAccess();
      return;
    }

    if (!res.ok) {
      showNoAccess();
      return;
    }

    data = await res.json();
  } catch {
    showNoAccess();
    return;
  } finally {
    showLoading(false);
  }

  allChannels = data.channels ?? [];
  if (data.watched_video_ids) {
    watchedVideoIds = new Set(data.watched_video_ids);
  }
  if (data.liked_video_ids) {
    likedVideoIds = new Set(data.liked_video_ids);
  }

  if (data.kid_name) {
    kidNameEl.textContent = data.kid_name;
  }

  renderTabs(allChannels, currentChannel);
  renderGrid(data.videos ?? []);

  feedScreen.classList.remove('hidden');
  noAccessScreen.classList.add('hidden');
}

// Exported so player.js can refresh the feed on return
export { loadFeed };

// --- No access screen ---

function showNoAccess() {
  showLoading(false);
  noAccessScreen.classList.remove('hidden');
  feedScreen.classList.add('hidden');
}

// --- Loading state ---

function showLoading(visible) {
  if (visible) {
    loadingEl.classList.remove('hidden');
  } else {
    loadingEl.classList.add('hidden');
  }
}

// --- Channel tabs ---

function renderTabs(channels, activeChannel) {
  channelTabsEl.textContent = '';

  // "All" tab
  const allTab = createTab('All', null, activeChannel === null);
  channelTabsEl.appendChild(allTab);

  for (const ch of channels) {
    const tab = createTab(ch.title, ch.channel_id, activeChannel === ch.channel_id);
    channelTabsEl.appendChild(tab);
  }
}

function createTab(label, channelId, isActive) {
  const btn = document.createElement('button');
  btn.className = 'channel-tab' + (isActive ? ' active' : '');
  btn.setAttribute('role', 'tab');
  btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  btn.textContent = label;
  btn.addEventListener('click', () => {
    if (searchMode) exitSearchMode();
    loadFeed(channelId ?? undefined);
  });
  return btn;
}

// --- Search ---

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

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { credentials: 'include' });

    if (res.status === 404) {
      showNoAccess();
      return;
    }

    const data = await res.json();
    if (data.liked_video_ids) {
      likedVideoIds = new Set(data.liked_video_ids);
    }

    videoGridEl.textContent = '';
    const videos = data.videos || [];

    if (videos.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No results found. Try a different search!';
      videoGridEl.appendChild(empty);
    } else {
      for (const video of videos) {
        videoGridEl.appendChild(createCard(video));
      }
    }
  } catch {
    videoGridEl.textContent = '';
    const err = document.createElement('p');
    err.className = 'empty-state';
    err.textContent = 'Search failed. Please try again.';
    videoGridEl.appendChild(err);
  } finally {
    showLoading(false);
  }
}

function enterSearchMode() {
  searchMode = true;
  channelTabsEl.classList.add('hidden');
}

function exitSearchMode() {
  searchMode = false;
  channelTabsEl.classList.remove('hidden');
  loadFeed(currentChannel ?? undefined);
}

// --- Like ---

export async function toggleLike(video) {
  const videoId = video.video_id;
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
      credentials: 'include',
      body: JSON.stringify({
        video_id: videoId,
        title: video.title || '',
        channel_title: video.channel_title || '',
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
  const cards = videoGridEl.querySelectorAll(`.video-card[data-video-id="${videoId}"] .btn-like`);
  for (const btn of cards) {
    btn.classList.toggle('liked', liked);
    btn.textContent = liked ? '\u2665' : '\u2661';
  }

  // Update player button
  const playerBtn = document.getElementById('player-like-btn');
  if (playerBtn && playerBtn.dataset.videoId === videoId) {
    playerBtn.classList.toggle('liked', liked);
    playerBtn.textContent = liked ? '\u2665' : '\u2661';
  }
}

// --- Video grid ---

function renderGrid(videos) {
  videoGridEl.textContent = '';

  if (videos.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No videos yet \u2014 check back soon!';
    videoGridEl.appendChild(empty);
    return;
  }

  for (const video of videos) {
    videoGridEl.appendChild(createCard(video));
  }
}

function createCard(video) {
  const isWatched = watchedVideoIds.has(video.video_id);
  const isLiked = likedVideoIds.has(video.video_id);

  const card = document.createElement('article');
  card.className = 'video-card' + (isWatched ? ' watched' : '');
  card.dataset.videoId = video.video_id;
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');

  // Thumbnail wrapper (for watched indicator overlay)
  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'thumb-wrap';

  if (video.thumbnail) {
    const img = document.createElement('img');
    img.className = 'video-thumb';
    img.src = video.thumbnail;
    img.alt = '';  // decorative; title below is the accessible label
    img.loading = 'lazy';
    thumbWrap.appendChild(img);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'video-thumb video-thumb--placeholder';
    thumbWrap.appendChild(placeholder);
  }

  // Watched indicator
  if (isWatched) {
    const watchedBadge = document.createElement('span');
    watchedBadge.className = 'watched-badge';
    watchedBadge.textContent = '\u2713 Watched';
    thumbWrap.appendChild(watchedBadge);
  }

  card.appendChild(thumbWrap);

  // Info block
  const info = document.createElement('div');
  info.className = 'video-info';

  const title = document.createElement('h3');
  title.className = 'video-title';
  title.textContent = video.title;
  info.appendChild(title);

  const metaRow = document.createElement('div');
  metaRow.className = 'video-meta';

  const channel = document.createElement('p');
  channel.className = 'video-channel';
  channel.textContent = video.channel_title;
  metaRow.appendChild(channel);

  // Like button
  const likeBtn = document.createElement('button');
  likeBtn.className = 'btn-like' + (isLiked ? ' liked' : '');
  likeBtn.setAttribute('aria-label', 'Like this video');
  likeBtn.textContent = isLiked ? '\u2665' : '\u2661';
  likeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleLike(video);
  });
  metaRow.appendChild(likeBtn);

  info.appendChild(metaRow);
  card.appendChild(info);

  // Click / keyboard open player
  const open = () => openPlayer(video);
  card.addEventListener('click', open);
  card.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });

  return card;
}

// --- Logout ---

document.getElementById('logout-btn').addEventListener('click', () => {
  document.cookie = 'yt_kid=; Max-Age=0; Path=/';
  window.location.href = '/';
});

// --- Start ---

init();
