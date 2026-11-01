# Google OAuth Setup

This guide walks you through creating a Google Cloud project and OAuth client so YourTube can import YouTube subscriptions and liked videos for a kid's account.

**This is optional.** YourTube works fine without OAuth — you just add channels manually in the admin UI. OAuth is only needed if you want a one-click import of an existing YouTube account's subs/likes.

## Overview

1. Create a Google Cloud project
2. Enable the YouTube Data API v3
3. Configure the OAuth consent screen
4. Create OAuth 2.0 credentials (Web application type)
5. Set environment variables in your `.env` file

## Step 1 — Create a Google Cloud project

1. Go to <https://console.cloud.google.com>
2. Click the project dropdown at the top → **New Project**
3. Give it a memorable name like `yourtube-home`
4. Click **Create**
5. Wait a few seconds, then select the new project from the dropdown

## Step 2 — Enable the YouTube Data API v3

1. In the left sidebar: **APIs & Services** → **Library**
2. Search for "YouTube Data API v3"
3. Click it → **Enable**

## Step 3 — Configure the OAuth consent screen

1. **APIs & Services** → **OAuth consent screen**
2. Choose **External** (since you'll be using a personal Google account to authenticate)
3. Fill in the required fields:
   - **App name**: `YourTube` (or whatever you want)
   - **User support email**: your email
   - **Developer contact email**: your email
4. Click **Save and Continue**
5. On the **Scopes** page, click **Add or Remove Scopes** and add:
   - `https://www.googleapis.com/auth/youtube.readonly`
6. **Save and Continue**
7. On the **Test users** page, add the Google account(s) you'll authenticate with. This is critical — if you don't add yourself here, OAuth will fail with an "access denied" error.
8. **Save and Continue** through the summary

The consent screen will be in "Testing" mode, which is fine. Test mode lets up to 100 test users authenticate, and you don't need to go through Google's app verification process.

## Step 4 — Create OAuth credentials

1. **APIs & Services** → **Credentials**
2. **Create Credentials** → **OAuth client ID**
3. **Application type**: **Web application** (not Desktop — the YourTube server runs on a port)
4. **Name**: `YourTube local`
5. **Authorized redirect URIs**: add
   ```
   http://localhost:3457/auth/callback
   ```
   (Adjust the port if you've set `YOURTUBE_PORT` to something else.)
6. Click **Create**
7. You'll see a dialog with your **Client ID** and **Client Secret**. Copy both.

## Step 5 — Set environment variables

Edit your `.env` file and add:

```bash
YOURTUBE_YOUTUBE_CLIENT_ID=<your client id>.apps.googleusercontent.com
YOURTUBE_YOUTUBE_CLIENT_SECRET=<your client secret>
```

Make sure `.env` has mode `600` so only you can read it:

```bash
chmod 600 .env
```

Restart the YourTube server. Then in the admin UI, you should see a **Connect YouTube** button that initiates the OAuth flow.

## What YourTube uses OAuth for

- **Subscriptions** — imported as the initial channel list for a kid
- **Liked videos** — imported as seed data for the AI taste profile (optional)

YourTube does **not** use OAuth for:

- Watch history (Google removed this from the API)
- Playlists
- Comments
- Anything that writes back to the user's YouTube account

## Troubleshooting

**"Error 403: access_denied"** — you're not in the Test users list (step 3.7). Add your Google account there.

**"Error 400: redirect_uri_mismatch"** — the `Authorized redirect URI` in Google Cloud doesn't match the URL YourTube is redirecting to. Check that the port and path match exactly, including `http://` (not `https://`) for local development.

**"Invalid grant"** — your refresh token expired (test-mode refresh tokens expire after 7 days). Re-run the OAuth flow from the admin UI.

**Session cookie not persisting** — make sure `YOURTUBE_SESSION_SECRET` is set to a stable value. If it's not set, a random one is generated per server start and all sessions are invalidated on restart.
