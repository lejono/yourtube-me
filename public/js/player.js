// YouTube IFrame Player API integration
// Manages video playback, end-of-video overlay, and watch tracking

import { toggleLike, likedVideoIds } from './app.js';

let ytPlayer = null;
let currentVideo = null;
let watchStartTime = null;
let apiReady = false;
let apiLoading = false;

// DOM refs
const playerScreen = document.getElementById('player-screen');
const feedScreen = document.getElementById('feed-screen');
const loginScreen = document.getElementById('login-screen');
const playerEmbed = document.getElementById('player-embed');
const playerOverlay = document.getElementById('player-overlay');
const playerTitle = document.getElementById('player-title');
const playerChannel = document.getElementById('player-channel');
const backBtn = document.getElementById('back-btn');
const replayBtn = document.getElementById('replay-btn');
const backToFeedBtn = document.getElementById('back-to-feed-btn');
const playerLikeBtn = document.getElementById('player-like-btn');

// Load the YouTube IFrame API script once
function loadYouTubeAPI() {
  if (apiReady || apiLoading) return;
  apiLoading = true;

  return new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => {
      apiReady = true;
      apiLoading = false;
      resolve();
    };

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
}

// Create or replace the YouTube player for a given video ID
function createPlayer(videoId) {
  // Destroy existing player if any
  if (ytPlayer) {
    ytPlayer.destroy();
    ytPlayer = null;
  }

  // The API replaces the target element, so we need a fresh div
  playerEmbed.innerHTML = '<div id="yt-player"></div>';

  ytPlayer = new YT.Player('yt-player', {
    width: '100%',
    height: '100%',
    videoId,
    playerVars: {
      rel: 0,
      modestbranding: 1,
      playsinline: 1,
      enablejsapi: 1,
      autoplay: 1,
    },
    events: {
      onStateChange: onPlayerStateChange,
      onError: onPlayerError,
    },
  });
}

function onPlayerStateChange(event) {
  const state = event.data;

  if (state === YT.PlayerState.PLAYING && !watchStartTime) {
    watchStartTime = Date.now();
    trackWatchStart(currentVideo.videoId);
  }

  if (state === YT.PlayerState.ENDED) {
    showOverlay();
    const duration = watchStartTime ? Math.round((Date.now() - watchStartTime) / 1000) : 0;
    trackWatchEnd(currentVideo.videoId, duration);
  }
}

function onPlayerError(event) {
  // Show overlay with error message on player errors
  const overlay = document.getElementById('player-overlay');
  const placeholder = overlay.querySelector('.overlay-placeholder');
  if (placeholder) {
    placeholder.textContent = 'This video could not be loaded.';
  }
  showOverlay();
}

function showOverlay() {
  playerOverlay.classList.remove('hidden');
}

function hideOverlay() {
  playerOverlay.classList.add('hidden');
}

// Track watch start
async function trackWatchStart(videoId) {
  try {
    await fetch('/api/watch/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, timestamp: new Date().toISOString() }),
    });
  } catch {
    // Non-critical — don't interrupt playback
  }
}

// Track watch end
async function trackWatchEnd(videoId, duration) {
  try {
    await fetch('/api/watch/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, timestamp: new Date().toISOString(), duration }),
    });
  } catch {
    // Non-critical
  }
}

// Open the player for a video
export async function openPlayer(video) {
  currentVideo = video;
  watchStartTime = null;

  // Update UI
  playerTitle.textContent = video.title || 'Untitled';
  playerChannel.textContent = video.channelTitle || '';
  hideOverlay();

  // Set like button state
  playerLikeBtn.dataset.videoId = video.videoId;
  const liked = likedVideoIds.has(video.videoId);
  playerLikeBtn.classList.toggle('liked', liked);
  const outline = playerLikeBtn.querySelector('.heart-outline');
  const filled = playerLikeBtn.querySelector('.heart-filled');
  if (outline) outline.classList.toggle('hidden', liked);
  if (filled) filled.classList.toggle('hidden', !liked);

  // Reset overlay placeholder text
  const placeholder = playerOverlay.querySelector('.overlay-placeholder');
  if (placeholder) {
    placeholder.textContent = 'Loading next picks...';
  }

  // Show player screen, hide feed
  feedScreen.classList.add('hidden');
  loginScreen.classList.add('hidden');
  playerScreen.classList.remove('hidden');

  // Scroll to top
  window.scrollTo(0, 0);

  // Load API if needed, then create player
  if (!apiReady) {
    await loadYouTubeAPI();
  }
  createPlayer(video.videoId);
}

// Close the player and return to feed
export function closePlayer() {
  if (ytPlayer) {
    // Track partial watch if video was playing
    if (watchStartTime && currentVideo) {
      const duration = Math.round((Date.now() - watchStartTime) / 1000);
      trackWatchEnd(currentVideo.videoId, duration);
    }
    ytPlayer.destroy();
    ytPlayer = null;
  }

  currentVideo = null;
  watchStartTime = null;
  playerEmbed.innerHTML = '';
  hideOverlay();

  playerScreen.classList.add('hidden');
  feedScreen.classList.remove('hidden');
}

// Replay current video
function replay() {
  if (!currentVideo) return;
  hideOverlay();
  watchStartTime = null;
  if (ytPlayer && typeof ytPlayer.seekTo === 'function') {
    ytPlayer.seekTo(0, true);
    ytPlayer.playVideo();
  } else {
    createPlayer(currentVideo.videoId);
  }
}

// Event listeners
backBtn.addEventListener('click', closePlayer);
backToFeedBtn.addEventListener('click', closePlayer);
replayBtn.addEventListener('click', replay);
playerLikeBtn.addEventListener('click', () => {
  if (currentVideo) toggleLike(currentVideo);
});
