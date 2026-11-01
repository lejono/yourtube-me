import { createHmac, randomBytes } from 'node:crypto';
import { SESSION_SECRET, YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET } from '../config.js';
import * as store from './store.js';

const TOKENS_FILE = 'tokens.json';
const REDIRECT_URI = 'http://localhost:3457/auth/callback';
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// 5-minute buffer before expiry to avoid race conditions
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

function hmacSign(data) {
  return createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
}

/**
 * Generate a Google OAuth authorization URL.
 * State parameter is HMAC-signed JSON binding the request to the admin session.
 */
export function getAuthURL(sessionId) {
  const nonce = randomBytes(16).toString('hex');
  const statePayload = JSON.stringify({ sessionId, nonce });
  const signature = hmacSign(statePayload);
  const state = Buffer.from(JSON.stringify({ payload: statePayload, sig: signature })).toString('base64url');

  const params = new URLSearchParams({
    client_id: YOUTUBE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    state,
    prompt: 'consent',
  });

  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * Validate the state parameter from the OAuth callback.
 * Verifies HMAC signature and that the session ID matches.
 * Returns true if valid, false otherwise.
 */
export function validateState(state, sessionId) {
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64url').toString());
    const { payload, sig } = decoded;
    const expected = hmacSign(payload);
    if (sig !== expected) return false;

    const { sessionId: stateSessionId } = JSON.parse(payload);
    return stateSessionId === sessionId;
  } catch {
    return false;
  }
}

/**
 * Exchange an authorization code for access + refresh tokens.
 * Returns the token response from Google.
 */
export async function exchangeCode(code) {
  const body = new URLSearchParams({
    code,
    client_id: YOUTUBE_CLIENT_ID,
    client_secret: YOUTUBE_CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await res.json();
  if (data.error) {
    throw new Error(`Token exchange failed: ${data.error} - ${data.error_description || ''}`);
  }

  // Store tokens with computed expiry time
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiry_time: Date.now() + (data.expires_in * 1000),
    scope: data.scope,
  };
  await store.write(TOKENS_FILE, tokens);

  return tokens;
}

/**
 * Refresh an expired access token using the refresh token.
 * Updates stored tokens and returns the new token data.
 */
export async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    client_id: YOUTUBE_CLIENT_ID,
    client_secret: YOUTUBE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await res.json();
  if (data.error) {
    // Clear stored tokens on refresh failure — user must re-auth
    await store.write(TOKENS_FILE, {});
    throw new Error(`Token refresh failed: ${data.error} - ${data.error_description || ''}`);
  }

  return data;
}

/**
 * Get a valid access token, refreshing if expired.
 * Throws if no tokens are stored (user must authenticate).
 */
export async function getValidToken() {
  const tokens = await store.read(TOKENS_FILE, {});
  if (!tokens.access_token) {
    throw new Error('No tokens stored. User must authenticate first.');
  }

  // Return cached token if still valid (with 5-min buffer)
  if (tokens.expiry_time && Date.now() < tokens.expiry_time - EXPIRY_BUFFER_MS) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    await store.write(TOKENS_FILE, {});
    throw new Error('Access token expired and no refresh token available.');
  }

  // Refresh the token
  const refreshed = await refreshAccessToken(tokens.refresh_token);
  const updated = {
    ...tokens,
    access_token: refreshed.access_token,
    expiry_time: Date.now() + (refreshed.expires_in * 1000),
  };
  await store.write(TOKENS_FILE, updated);

  return updated.access_token;
}
