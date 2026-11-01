/**
 * player.js — YouTube iframe player panel
 * Exports openPlayer(video) and closePlayer().
 */

import { toggleLike, likedVideoIds, loadFeed } from './app.js';

const playerScreen = document.getElementById('player-screen');
const playerContainer = document.getElementById('player-container');
const playerInfo = document.getElementById('player-info');
const backBtn = document.getElementById('back-btn');

let currentVideo = null;

backBtn.addEventListener('click', closePlayer);

export function openPlayer(video) {
  currentVideo = video;

  // Clear any previous player
  playerContainer.textContent = '';
  playerInfo.textContent = '';

  // Build iframe — sandbox prevents navigation to youtube.com
  const iframe = document.createElement('iframe');
  iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.video_id)}?autoplay=1&controls=1&rel=0&modestbranding=1`;
  iframe.allow = 'autoplay; encrypted-media; fullscreen';
  iframe.allowFullscreen = true;
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
  iframe.className = 'player-iframe';
  playerContainer.appendChild(iframe);

  // Video title
  const title = document.createElement('h2');
  title.className = 'player-title';
  title.textContent = video.title;
  playerInfo.appendChild(title);

  // Channel name
  const channel = document.createElement('p');
  channel.className = 'player-channel';
  channel.textContent = video.channel_title;
  playerInfo.appendChild(channel);

  // Like button
  const liked = likedVideoIds.has(video.video_id);
  const likeBtn = document.createElement('button');
  likeBtn.id = 'player-like-btn';
  likeBtn.className = 'btn-like player-like-btn' + (liked ? ' liked' : '');
  likeBtn.dataset.videoId = video.video_id;
  likeBtn.setAttribute('aria-label', 'Like this video');
  likeBtn.textContent = liked ? '\u2665' : '\u2661';
  likeBtn.addEventListener('click', () => {
    if (currentVideo) toggleLike(currentVideo);
  });
  playerInfo.appendChild(likeBtn);

  // Show player, hide feed
  document.getElementById('feed-screen').classList.add('hidden');
  playerScreen.classList.remove('hidden');

  // Scroll to top
  window.scrollTo(0, 0);

  // Record the watch
  trackWatch(video.video_id);
}

export function closePlayer() {
  // Stop video by removing the iframe
  playerContainer.textContent = '';
  playerInfo.textContent = '';
  currentVideo = null;

  playerScreen.classList.add('hidden');
  document.getElementById('feed-screen').classList.remove('hidden');

  // Refresh feed to update watched state
  loadFeed();
}

async function trackWatch(videoId) {
  try {
    await fetch('/api/watch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ video_id: videoId }),
    });
  } catch {
    // Non-critical — don't interrupt playback
  }
}
