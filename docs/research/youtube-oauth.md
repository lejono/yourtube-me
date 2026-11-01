# YouTube Data API v3 OAuth 2.0 Research

Research compiled 2026-03-15 from current Google documentation.

---

## 1. OAuth Setup in Google Cloud Console

### Credentials Type

You need an **OAuth 2.0 Client ID**. This is distinct from an API key (which only works for public data, not user-specific data like subscriptions or liked videos).

### Application Type: Web Application

For a local Node.js server listening on a specific port, choose **"Web application"** (not "Desktop app").

**Why not Desktop app?** The "Desktop app" type is designed for native applications that use the loopback IP redirect flow (`http://127.0.0.1`) with a *dynamically assigned port*. It does not allow you to configure specific redirect URIs in the console. A local Node.js web server with a fixed port and explicit callback route is functionally a web application, so "Web application" is the correct choice.

With "Web application" selected, you get:
- A **client ID** and **client secret** (both needed for server-side token exchange)
- The ability to configure **authorized redirect URIs**

### Redirect URI

For your app running on `localhost:3457`:

```
http://localhost:3457/callback
```

Key rules:
- **HTTP is allowed for localhost** -- the HTTPS requirement is waived for localhost and loopback addresses
- The redirect URI in the authorization request must **exactly match** one of the URIs registered in the console (including path, port, and trailing slash)
- You can register multiple redirect URIs (e.g., one for dev, one for production)

### Consent Screen

Before creating OAuth credentials, you must configure the OAuth consent screen:

1. Go to **Google Auth Platform > Branding** in Cloud Console
2. Set **User Type** to **External** (unless you have a Google Workspace org and only need internal access)
3. Provide:
   - App name (e.g., "YourTube")
   - User support email
   - Developer contact email
4. Add the required scopes (see below)

**Testing mode specifics:**
- Apps start in **Testing** publishing status
- Limited to **100 test users** over the lifetime of the project (this cap cannot be reset)
- You must explicitly add test user email addresses in the console under **Audience > Add users**
- Test user authorizations **expire after 7 days** -- the user must re-consent after that
- Google shows a warning screen to test users ("This app isn't verified") but they can click through it
- For personal use on a local app, testing mode is sufficient; you never need to go through verification

**Verification requirements (if you ever publish):**
- `youtube.readonly` is classified as a **sensitive scope**, which requires basic app verification
- Verification involves submitting your app for Google review, providing a privacy policy, etc.
- For a personal local tool, you can stay in testing mode indefinitely and skip all of this

### Required Scopes

For **read-only** access to subscriptions and liked videos, you need:

```
https://www.googleapis.com/auth/youtube.readonly
```

This single scope covers:
- Listing the authenticated user's subscriptions (`subscriptions.list` with `mine=true`)
- Listing the authenticated user's liked videos (`videos.list` with `myRating=like`)
- Reading channel information, playlists, etc.

You do **not** need `youtube.force-ssl` (that grants write access) or the full `youtube` scope (which grants full account management).

---

## 2. The OAuth Flow for a Local App

### Overview: Authorization Code Flow

```
User clicks "Sign in" on your local app
        |
        v
Browser redirects to Google's authorization page
        |
        v
User grants consent
        |
        v
Google redirects browser to http://localhost:3457/callback?code=AUTH_CODE&state=...
        |
        v
Your server exchanges AUTH_CODE for access_token + refresh_token (server-to-server HTTPS POST)
        |
        v
Your server uses access_token to call YouTube API
```

### Step 1: Generate Authorization URL

Redirect the user's browser to:

```
https://accounts.google.com/o/oauth2/v2/auth
```

With query parameters:

| Parameter | Value |
|-----------|-------|
| `client_id` | Your OAuth client ID |
| `redirect_uri` | `http://localhost:3457/callback` |
| `response_type` | `code` |
| `scope` | `https://www.googleapis.com/auth/youtube.readonly` |
| `access_type` | `offline` (to receive a refresh token) |
| `state` | A random string for CSRF protection |
| `prompt` | `consent` (forces consent screen, ensures refresh token is returned) |

### Step 2: Handle the Callback

Google redirects the browser to your callback URL with:
- `code` -- the authorization code (single-use, expires in minutes)
- `state` -- your CSRF token (verify it matches what you sent)

If the user denies access, you get `error=access_denied` instead.

### Step 3: Exchange Code for Tokens

POST to:

```
https://oauth2.googleapis.com/token
```

With `Content-Type: application/x-www-form-urlencoded` body:

| Parameter | Value |
|-----------|-------|
| `code` | The authorization code from the callback |
| `client_id` | Your OAuth client ID |
| `client_secret` | Your OAuth client secret |
| `redirect_uri` | `http://localhost:3457/callback` (must match exactly) |
| `grant_type` | `authorization_code` |

Response (JSON):

```json
{
  "access_token": "ya29.a0AfH6SM...",
  "expires_in": 3600,
  "refresh_token": "1//0eXy7...",
  "scope": "https://www.googleapis.com/auth/youtube.readonly",
  "token_type": "Bearer"
}
```

**Important:** The `refresh_token` is only returned on the **first** authorization, or when you include `prompt=consent` in the authorization URL. Store it securely.

### Step 4: Refresh the Access Token

Access tokens expire after 1 hour (`expires_in: 3600`). To get a new one without user interaction:

POST to:

```
https://oauth2.googleapis.com/token
```

With body:

| Parameter | Value |
|-----------|-------|
| `client_id` | Your OAuth client ID |
| `client_secret` | Your OAuth client secret |
| `refresh_token` | The stored refresh token |
| `grant_type` | `refresh_token` |

Response:

```json
{
  "access_token": "ya29.a0NEW...",
  "expires_in": 3600,
  "scope": "https://www.googleapis.com/auth/youtube.readonly",
  "token_type": "Bearer"
}
```

Note: The refresh token itself does not expire (unless the user revokes access, or the app stays in testing mode where tokens expire after 7 days).

### Token Revocation

To programmatically revoke access:

```
POST https://oauth2.googleapis.com/revoke?token={access_token_or_refresh_token}
```

---

## 3. API Calls with OAuth Token

All API calls include the header:

```
Authorization: Bearer {access_token}
```

### List All Subscriptions (with Pagination)

```
GET https://www.googleapis.com/youtube/v3/subscriptions
    ?part=snippet
    &mine=true
    &maxResults=50
    &pageToken={nextPageToken}
```

| Parameter | Details |
|-----------|---------|
| `part` | `snippet` gives you channel title, thumbnail, description. Can also include `contentDetails`, `id` |
| `mine` | `true` -- returns the authenticated user's subscriptions |
| `maxResults` | 1-50, default 5. Use 50 to minimize API calls |
| `pageToken` | Omit on first request. Use `nextPageToken` from response for subsequent pages |
| `order` | Optional: `alphabetical`, `relevance` (default), or `unread` |

**Quota cost:** 1 unit per request (regardless of page size).

**Pagination:** The response includes `nextPageToken` if there are more results. Keep requesting with `pageToken=nextPageToken` until `nextPageToken` is absent. The response also includes `pageInfo.totalResults` so you know the total count upfront.

**Example response structure:**

```json
{
  "kind": "youtube#subscriptionListResponse",
  "pageInfo": { "totalResults": 247, "resultsPerPage": 50 },
  "nextPageToken": "CDIQAA",
  "items": [
    {
      "snippet": {
        "title": "Channel Name",
        "resourceId": { "channelId": "UC..." },
        "thumbnails": { ... }
      }
    }
  ]
}
```

For 247 subscriptions at 50 per page, you need 5 requests = 5 quota units.

### Get Liked Videos

```
GET https://www.googleapis.com/youtube/v3/videos
    ?part=snippet,contentDetails
    &myRating=like
    &maxResults=50
    &pageToken={nextPageToken}
```

| Parameter | Details |
|-----------|---------|
| `part` | `snippet` for title/description/thumbnails, `contentDetails` for duration, `statistics` for view counts |
| `myRating` | `like` returns videos the user has liked; `dislike` for disliked |
| `maxResults` | 1-50, default 5 |
| `pageToken` | For pagination, same pattern as subscriptions |

**Quota cost:** 1 unit per request.

**Note:** The `myRating` parameter cannot be used with the `id` parameter simultaneously.

### Watch History: NOT Accessible via API

Watch history access was **deprecated on 11 August 2016** and **fully removed on 12 September 2016**.

Previously, you could get a watch history playlist ID via `channels.list` (`contentDetails.relatedPlaylists.watchHistory`), but now:
- The property returns a fixed dummy value `"HL"` for all channels
- `playlistItems.list` for that playlist returns an empty list
- There is no alternative API endpoint for watch history

The only way to get watch history is through [Google Takeout](https://takeout.google.com/) (manual export, not API-accessible).

### Quota Budget

- Default daily quota: **10,000 units**
- Quota resets at **midnight Pacific Time**
- Read operations (list methods): **1 unit each**

For a personal tool pulling subscriptions and liked videos:
- 250 subscriptions = ~5 requests = 5 units
- 5,000 liked videos = ~100 requests = 100 units
- Total: ~105 units out of 10,000 daily budget (about 1%)

---

## 4. Security Considerations

### Client Secret Storage

For a local-only app, the client secret is not truly secret (anyone with access to your machine can extract it), but you should still follow reasonable practices:

- Store `client_id` and `client_secret` in a `.env` file
- Add `.env` to `.gitignore`
- Load via `process.env` or a library like `dotenv`
- Never commit credentials to version control

The client secret for a local app is more of a "client identifier" than a real secret. Google knows this, which is why they recommend PKCE for installed apps. For a personal local server app, the standard authorization code flow with a client secret is fine.

### Token Storage

- Store the refresh token in a local file (e.g., `.tokens.json`) with restrictive permissions (`chmod 600`)
- Add the token file to `.gitignore`
- The refresh token is the critical credential -- anyone with it can get new access tokens
- Access tokens are short-lived (1 hour) and don't need persistent storage beyond memory

### Scope Restrictions

- Request the **minimum scope** needed: `youtube.readonly` for read-only access
- Never request `youtube` or `youtube.force-ssl` unless you need write access
- After the user consents, verify which scopes were actually granted (the user can deny individual scopes)

### PKCE (Optional Enhancement)

While PKCE (Proof Key for Code Exchange) is recommended by Google for installed/desktop apps, it's optional for "Web application" type credentials that use a client secret. If you want to add it:

```javascript
const crypto = require('crypto');

// Generate code verifier (43-128 chars, alphanumeric + -._~)
const codeVerifier = crypto.randomBytes(32)
  .toString('base64url');

// Generate code challenge (SHA256 hash, base64url-encoded)
const codeChallenge = crypto.createHash('sha256')
  .update(codeVerifier)
  .digest('base64url');

// Add to authorization URL:
//   &code_challenge={codeChallenge}
//   &code_challenge_method=S256

// Add to token exchange request:
//   code_verifier={codeVerifier}
```

---

## 5. Practical Node.js Example

Complete working example using only built-in Node.js modules (`http`, `https`, `url`, `crypto`, `fs`):

```javascript
const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// --- Configuration ---
// Load these from .env in production
const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3457/callback';
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const TOKEN_PATH = path.join(__dirname, '.tokens.json');

// --- Token Management ---

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

// --- OAuth Helpers ---

function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

function buildAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    state: state,
    prompt: 'consent',  // ensures refresh_token is returned
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function exchangeCodeForTokens(code) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }).toString();

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const data = JSON.parse(body);
        if (data.error) {
          reject(new Error(`Token exchange failed: ${data.error} - ${data.error_description}`));
        } else {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function refreshAccessToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString();

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const data = JSON.parse(body);
        if (data.error) {
          reject(new Error(`Token refresh failed: ${data.error} - ${data.error_description}`));
        } else {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// --- YouTube API Helpers ---

function youtubeApiGet(path, accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.googleapis.com',
      path: path,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const data = JSON.parse(body);
        if (data.error) {
          reject(new Error(`API error: ${data.error.code} ${data.error.message}`));
        } else {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function getValidAccessToken() {
  const tokens = loadTokens();
  if (!tokens) {
    throw new Error('No tokens stored. User must authenticate first.');
  }

  // Check if access token is expired (with 5-minute buffer)
  const now = Date.now();
  if (tokens.expiry_time && now < tokens.expiry_time - 300000) {
    return tokens.access_token;
  }

  // Refresh the token
  console.log('Access token expired, refreshing...');
  const refreshed = await refreshAccessToken(tokens.refresh_token);
  const updatedTokens = {
    ...tokens,
    access_token: refreshed.access_token,
    expiry_time: Date.now() + (refreshed.expires_in * 1000),
  };
  saveTokens(updatedTokens);
  return updatedTokens.access_token;
}

// --- API Methods ---

async function getAllSubscriptions(accessToken) {
  const allSubs = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      part: 'snippet',
      mine: 'true',
      maxResults: '50',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const data = await youtubeApiGet(
      `/youtube/v3/subscriptions?${params.toString()}`,
      accessToken
    );

    for (const item of data.items) {
      allSubs.push({
        channelId: item.snippet.resourceId.channelId,
        title: item.snippet.title,
        description: item.snippet.description,
        thumbnail: item.snippet.thumbnails?.default?.url,
      });
    }

    pageToken = data.nextPageToken || null;
    console.log(`Fetched ${allSubs.length} / ${data.pageInfo.totalResults} subscriptions`);
  } while (pageToken);

  return allSubs;
}

async function getLikedVideos(accessToken, maxPages = Infinity) {
  const allVideos = [];
  let pageToken = null;
  let page = 0;

  do {
    const params = new URLSearchParams({
      part: 'snippet,contentDetails',
      myRating: 'like',
      maxResults: '50',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const data = await youtubeApiGet(
      `/youtube/v3/videos?${params.toString()}`,
      accessToken
    );

    for (const item of data.items) {
      allVideos.push({
        videoId: item.id,
        title: item.snippet.title,
        channelTitle: item.snippet.channelTitle,
        publishedAt: item.snippet.publishedAt,
        duration: item.contentDetails.duration,
        thumbnail: item.snippet.thumbnails?.default?.url,
      });
    }

    pageToken = data.nextPageToken || null;
    page++;
    console.log(`Fetched ${allVideos.length} liked videos (page ${page})`);
  } while (pageToken && page < maxPages);

  return allVideos;
}

// --- HTTP Server ---

let pendingState = null;

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  // Home / status page
  if (reqUrl.pathname === '/') {
    const tokens = loadTokens();
    if (tokens) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <h1>YourTube</h1>
        <p>Authenticated.</p>
        <ul>
          <li><a href="/subscriptions">List Subscriptions</a></li>
          <li><a href="/liked">List Liked Videos</a></li>
          <li><a href="/auth">Re-authenticate</a></li>
        </ul>
      `);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <h1>YourTube</h1>
        <p>Not authenticated.</p>
        <p><a href="/auth">Sign in with Google</a></p>
      `);
    }
    return;
  }

  // Start OAuth flow
  if (reqUrl.pathname === '/auth') {
    pendingState = generateState();
    const authUrl = buildAuthUrl(pendingState);
    res.writeHead(302, { 'Location': authUrl });
    res.end();
    return;
  }

  // OAuth callback
  if (reqUrl.pathname === '/callback') {
    const code = reqUrl.searchParams.get('code');
    const state = reqUrl.searchParams.get('state');
    const error = reqUrl.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`Authorization denied: ${error}`);
      return;
    }

    if (state !== pendingState) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('State mismatch -- possible CSRF attack');
      return;
    }
    pendingState = null;

    try {
      const tokens = await exchangeCodeForTokens(code);
      saveTokens({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_time: Date.now() + (tokens.expires_in * 1000),
        scope: tokens.scope,
      });
      res.writeHead(302, { 'Location': '/' });
      res.end();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Token exchange failed: ${err.message}`);
    }
    return;
  }

  // List subscriptions
  if (reqUrl.pathname === '/subscriptions') {
    try {
      const accessToken = await getValidAccessToken();
      const subs = await getAllSubscriptions(accessToken);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(subs, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Error: ${err.message}`);
    }
    return;
  }

  // List liked videos
  if (reqUrl.pathname === '/liked') {
    try {
      const accessToken = await getValidAccessToken();
      const videos = await getLikedVideos(accessToken);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(videos, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Error: ${err.message}`);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(3457, () => {
  console.log('YourTube server running at http://localhost:3457');
  console.log('Open the URL above to begin.');
});
```

### Required `.env` File

```bash
YOUTUBE_CLIENT_ID=your-client-id-here.apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=GOCSPX-your-secret-here
```

### Required `.gitignore` Entries

```
.env
.tokens.json
```

---

## 6. Quick Setup Checklist

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select existing)
3. Enable the **YouTube Data API v3** (APIs & Services > Library)
4. Configure the **OAuth consent screen**:
   - User type: External
   - App name, support email, developer contact email
   - Add scope: `youtube.readonly`
   - Add your Google account as a test user
5. Create **OAuth 2.0 Client ID** credentials:
   - Application type: **Web application**
   - Authorized redirect URI: `http://localhost:3457/callback`
6. Copy the client ID and client secret to your `.env` file
7. Run the server and visit `http://localhost:3457`

---

## 7. Gotchas and Edge Cases

- **Refresh token only on first consent:** If you've already authorized the app and try again without `prompt=consent`, Google won't return a new refresh token. Either use `prompt=consent` every time, or revoke the app's access at https://myaccount.google.com/permissions first.

- **Testing mode token expiry:** In testing mode, user consent expires after 7 days. The user must re-authenticate. This is a Google-imposed limit, not something you can work around.

- **100 test user cap:** The 100-user limit is lifetime, not concurrent. For a personal app this is irrelevant (you're the only user), but worth knowing.

- **Quota pagination cost:** Each page of results costs 1 quota unit, regardless of how many items are in the page. Maximize `maxResults=50` to minimize quota usage.

- **Liked videos can be very large:** Some users have thousands of liked videos. The API paginates at 50 per page, so 5,000 likes = 100 API calls = 100 quota units. Consider caching or limiting pages.

- **Rate limiting:** Beyond quota, Google may rate-limit rapid consecutive requests. Add a small delay between pagination requests if you hit 403 errors with `rateLimitExceeded`.

- **Scope verification on response:** After the user consents, check the `scope` field in the token response to confirm the user actually granted `youtube.readonly`. They can deny it.

---

## Sources

- [YouTube Data API: Server-Side Web Apps OAuth Guide](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps)
- [YouTube Data API: Installed/Desktop Apps OAuth Guide](https://developers.google.com/youtube/v3/guides/auth/installed-apps)
- [YouTube Data API: Subscriptions.list](https://developers.google.com/youtube/v3/docs/subscriptions/list)
- [YouTube Data API: Videos.list](https://developers.google.com/youtube/v3/docs/videos/list)
- [YouTube Data API: Quota Calculator](https://developers.google.com/youtube/v3/determine_quota_cost)
- [YouTube Data API: Revision History (watch history deprecation)](https://developers.google.com/youtube/v3/revision_history)
- [Google OAuth 2.0 Overview](https://developers.google.com/identity/protocols/oauth2)
- [Setting Up OAuth 2.0 Credentials](https://support.google.com/googleapi/answer/6158849)
- [OAuth Consent Screen Configuration](https://developers.google.com/workspace/guides/configure-oauth-consent)
- [Google OAuth Consent Screen: App Audience](https://support.google.com/cloud/answer/15549945)
- [Watch History Issue Tracker](https://issuetracker.google.com/issues/35172816)
- [Node.js Quickstart for YouTube Data API](https://developers.google.com/youtube/v3/quickstart/nodejs)
