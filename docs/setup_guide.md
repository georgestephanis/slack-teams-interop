# InterBridge Setup & Deployment Guide

This guide walks you through setting up your self-hosted Slack <-> Microsoft Teams bridge, from creating the platform apps to your first relayed message.

---

## 1. Prerequisites
- A **Slack workspace** where you can create and install apps (or a Slack admin who can approve one).
- A **Microsoft 365 tenant** where you are a **Team Owner** of the team to bridge, and where custom app uploads are allowed. Ask your Teams admin if **Upload a custom app** isn't available.
- An **Azure subscription** for the Azure Bot registration. The free F0 tier is enough.
- A server with **Docker**, or **Node.js 22+**.
- A **public HTTPS URL** for the bridge (for example `https://bridge.example.com`), through a reverse proxy such as Caddy or Nginx, or a Cloudflare Tunnel. Azure Bot Service must be able to reach `/api/messages`.

---

## 2. Slack Setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps).
2. Click **Create New App** -> **From an app manifest**.
3. Choose your workspace and paste the contents of [`manifests/slack/manifest.json`](../manifests/slack/manifest.json).
4. Review the scopes. [SECURITY.md](../SECURITY.md) explains each one:
   - `chat:write`, `chat:write.customize` (sender display names & avatars)
   - `channels:history`, `groups:history`, `files:read`, `files:write`, `reactions:read`, `reactions:write`, `users:read`

   To bridge **private channels only**, remove `channels:history` and the `message.channels` event before creating the app.
5. Click **Create**, then **Install to Workspace**, and authorize it.
6. Generate an **App-Level Token** for Socket Mode:
   - **Basic Information** -> **App-Level Tokens** -> **Generate Token and Scopes**.
   - Name it `interbridge-socket`, add the `connections:write` scope, and copy the token (`xapp-...`).
7. Copy the **Bot User OAuth Token** (`xoxb-...`) from **OAuth & Permissions**.

> **Invite the bot to each Slack channel you bridge.** Slack only delivers events to a bot from channels the bot is a member of. In the channel, run `/invite @InterBridge`. Until you do, nothing from that channel is relayed.

### Alternative: HTTP (Events API) mode

Use this if your organization doesn't allow Socket Mode apps, or you'd rather receive Slack events over HTTPS alongside the Teams webhook.

1. In `.env`, set:
   - `SLACK_USE_SOCKET_MODE=false`
   - `SLACK_SIGNING_SECRET`, from **Basic Information** -> **App Credentials**
   - `PUBLIC_URL`, the bridge's public HTTPS base URL

   `SLACK_APP_TOKEN` isn't needed.
2. Create the app from the manifest generated at `GET /api/manifests/slack?mode=http`. It sets `socket_mode_enabled: false` and a Request URL of `<PUBLIC_URL>/slack/events`.
   - Like the rest of the admin API, this endpoint requires the dashboard login. For example: `curl -u admin:$ADMIN_PASSWORD "$PUBLIC_URL/api/manifests/slack?mode=http"`.
   - Alternatively, edit an existing app's **Event Subscriptions** to use that URL.
3. Make sure your reverse proxy forwards `/slack/events` to the bridge, on the same port as `/api/messages`.
   - Like the Teams webhook, it's authenticated by the platform (Slack's request signature), not the admin password.
   - Slack's URL verification challenge is answered automatically once the bridge is running.

---

## 3. Microsoft Teams Setup (Resource-Specific Consent)

InterBridge uses **Resource-Specific Consent (RSC)**, so a Team Owner can install it for a single team without tenant-wide admin consent.

### Step 3.1: Create the Azure Bot registration
1. Go to the [Azure Portal](https://portal.azure.com/).
2. Search for **Azure Bot** -> **Create**.
3. Fill in:
   - **Bot handle**: e.g. `interbridge-bot` (must be unique)
   - **Pricing tier**: `Free F0`
   - **Type of App**: **Single Tenant**. Azure no longer offers *Multi Tenant* for new bots; an existing multi-tenant registration still works (see `TEAMS_APP_TYPE` below).
   - **Creation type**: *Create new Microsoft App ID*
4. Once it's created, open **Configuration**:
   - Set **Messaging endpoint** to `https://<your-public-domain>/api/messages`.
   - Copy the **Microsoft App ID** (becomes `TEAMS_APP_ID`) and the **App Tenant ID** (becomes `TEAMS_TENANT_ID`).
   - Next to Microsoft App ID, click **Manage Password** -> **New client secret**, and copy the secret's **Value** (becomes `TEAMS_APP_PASSWORD`).
5. Under **Channels**, add **Microsoft Teams** and accept the terms.

### Step 3.2: Package and install the Teams app
1. Edit [`manifests/teams/manifest.json`](../manifests/teams/manifest.json) and replace `"YOUR_AZURE_BOT_APP_ID"` with your Microsoft App ID.
2. Build the package:
   ```bash
   npm run package:teams   # writes public/teams-app.zip
   ```
   This needs the `zip` command. The zip is simply `manifest.json`, `color.png` and `outline.png` at the top level, so you can also create it by hand.

   > The prebuilt `public/teams-app.zip` in the repo (also offered on the dashboard as **Download Teams App Package**) contains the **placeholder** bot ID. It won't work until you rebuild it with your own ID.
3. In Microsoft Teams:
   - Go to the team you want to bridge.
   - Click **⋯** next to the team name -> **Manage team** -> **Apps** -> **Upload a custom app** (or upload it to your tenant's app catalog).
   - Select the zip file and click **Add**. As Team Owner, you consent to `ChannelMessage.Read.Group` for this team.

---

## 4. Environment Configuration

Copy the example file and edit it:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `ADMIN_PASSWORD` | **Yes** | `admin` | Password for the dashboard and admin API (HTTP Basic auth, any username). **Change it.** |
| `PUBLIC_URL` | Recommended | — | Public HTTPS base URL, e.g. `https://bridge.example.com`. Used in generated manifests and required for the image proxy. |
| `PORT` | No | `3978` | Port for the web server, webhooks and dashboard. |
| `HOST` | No | `0.0.0.0` | Interface to listen on. |
| `DATABASE_PATH` | No | `./data/bridge.sqlite` | SQLite database file. The Docker image uses `/data/bridge.sqlite`. |
| `MESSAGE_RETENTION_DAYS` | No | `30` | How long message pairs, and their stored text, are kept. Threads, edits and reactions only work within this window. |
| `SLACK_BOT_TOKEN` | For Slack | — | Bot User OAuth Token (`xoxb-...`). |
| `SLACK_APP_TOKEN` | Socket Mode | — | App-level token (`xapp-...`) with `connections:write`. |
| `SLACK_SIGNING_SECRET` | HTTP mode | — | Slack signing secret; verifies `/slack/events` requests. |
| `SLACK_USE_SOCKET_MODE` | No | `true` | `true` for Socket Mode, `false` for the HTTP Events API. |
| `TEAMS_APP_ID` | For Teams | — | Azure Bot Microsoft App ID. |
| `TEAMS_APP_PASSWORD` | For Teams | — | Azure Bot client secret value. |
| `TEAMS_TENANT_ID` | Single-tenant | — | Your Microsoft Entra tenant ID. |
| `TEAMS_APP_TYPE` | No | `MultiTenant` | Must match the bot's **Type of App**. New bots: set `SingleTenant` (it also needs `TEAMS_TENANT_ID`). |
| `TEAMS_SERVICE_URL` | No | `https://smba.trafficmanager.net/amer/` | Fallback Bot Framework endpoint. See the note below. |
| `MEDIA_PROXY_SECRET` | No | — | At least 32 characters. Enables inline Slack images in Teams; see [Section 5](#5-optional-show-slack-images-inline-in-teams). |

The bridge starts with whichever platforms are configured. Without Slack or Teams credentials, it runs in dashboard/API-only mode.

> **About `TEAMS_SERVICE_URL`:** Bot Framework routes proactive posts through a region-specific service URL. The bridge learns the correct URL from the first activity it receives from a team (installing the app counts), and stores it in the database. `TEAMS_SERVICE_URL` is only a fallback for channels it hasn't heard from yet. If your tenant is outside the Americas, set it to your region's endpoint (for example `https://smba.trafficmanager.net/emea/` or `.../apac/`). The dashboard flags bridges whose Teams channel hasn't been seen yet.

---

## 5. Optional: Show Slack Images Inline in Teams

Images shared in Teams are always copied into Slack, as long as the bridge's **Sync File Attachments** option is on. The other direction needs an opt-in, because Teams loads card images directly from a URL, and Slack file URLs require the bot token.

1. Set `PUBLIC_URL` to the bridge's public HTTPS base URL.
2. Set `MEDIA_PROXY_SECRET` to a long random value, for example `openssl rand -base64 48`.
3. Make sure your reverse proxy forwards `/media/slack/*` to the bridge.

With this set, Slack images appear inside the relayed Teams message.
- Each image URL is **signed**: anyone who has the link can view that one image, but can't use it to reach anything else.
- Changing `MEDIA_PROXY_SECRET` revokes every link at once, including on older messages.
- The proxy only fetches from `files.slack.com`, refuses SVGs, and caps images at 20 MB.

Without these settings, Slack images are relayed as a named link.

---

## 6. Running the Service

### Option A: Docker Compose (recommended)

```bash
docker compose up -d
```

The database is kept in `./data` on the host. Open the dashboard at `http://localhost:3978`, or your `PUBLIC_URL` if you proxy it.

### Option B: Node.js

```bash
npm install

# Development, with auto-reload
npm run dev

# Or build and run for production
npm run build
npm start
```

### Upgrading

Pull the new version and restart. On startup, the bridge applies any pending database migrations, and **before upgrading an existing database it writes a backup** next to it (`bridge.sqlite.bak-v<N>`). Once the new version is running fine, delete old backups: they contain message text and aren't pruned automatically.

Running an older version against a database that a newer version has upgraded is refused, with a clear error. Restore the matching backup to roll back.

---

## 7. Configuring Channel Bridges

1. Open the dashboard and sign in with any username and your `ADMIN_PASSWORD`.
2. Click **Add Channel Bridge** and fill in:
   - **Bridge Name**: e.g. `Client Alpha Sync`.
   - **Slack Channel ID**: right-click the channel -> **Copy link**. The ID is the last part, e.g. `C0123456789`.
   - **Teams Team ID** and **Teams Channel ID**: in Teams, click **⋯** next to the channel -> **Get link to channel**. The link contains the channel ID in URL-encoded form, e.g. `19%3a1a2b3c...%40thread.tacv2`. **Decode it** before pasting (`%3a` → `:`, `%40` → `@`), giving `19:1a2b3c...@thread.tacv2`. For the Team ID, use **Get link to team** and decode the same `19:...@thread.tacv2` part of that link.
   - **Teams Display Style**: **Adaptive Card** (sender avatar and name) or **Clean Markdown** (`**[Slack] Jane Doe**` header).
   - **Options**:

     | Option | Default | What it does |
     | :--- | :--- | :--- |
     | Sync Threaded Replies | On | Keep replies in the matching thread. |
     | Sync Emoji Reactions | On | Mirror reactions (native in Slack; a footer in Teams). |
     | Post Slack reactions on Teams-authored messages as a thread reply | Off | Also show Slack reactions on messages written in Teams, as one self-updating reply. |
     | Sync File Attachments | On | Relay images (copied, or proxied into Teams) and file links. |
     | Tell senders when something they shared couldn't be relayed | On | A private Slack message or a Teams thread reply, at most once per 12 hours per person and problem. |
     | Sync Message Edits | On | Mirror edits made where the message was written. |
     | Sync Message Deletions | On | Mirror deletions made where the message was written. |

3. Click **Save Bridge**, then click **Test** on the new row. This sends a diagnostic message to the **Slack** channel only.
4. Send a message in each channel to check both directions.

To change a bridge's options later, delete it and add it again with the same channel IDs. Message history for the pair is kept only while the bridge exists.

---

## 8. Troubleshooting

| Symptom | Likely cause |
| :--- | :--- |
| Nothing relays from Slack | The bot isn't in the channel (`/invite @InterBridge`), the Slack channel ID is wrong, or the dashboard shows Slack **Offline** (check the tokens and the logs). |
| Nothing relays from Teams | The Teams app isn't installed in that team, the messaging endpoint in Azure doesn't point to `https://<PUBLIC_URL>/api/messages`, or the channel ID wasn't URL-decoded. |
| Teams returns 401/403, or the logs show "Teams Turn Error" auth failures | `TEAMS_APP_TYPE` doesn't match the Azure bot's **Type of App**, or `TEAMS_TENANT_ID`/`TEAMS_APP_PASSWORD` is wrong or expired. |
| Slack → Teams fails for a non-US tenant | The bridge hasn't seen that team yet and is using the `TEAMS_SERVICE_URL` fallback. Send any message in the Teams channel, or set `TEAMS_SERVICE_URL` to your region. The dashboard shows "⚠ region not yet detected". |
| Teams says the app package is invalid, or messages are ignored | The package still has the placeholder bot ID. Rebuild it after editing `manifest.json` (Step 3.2). |
| Slack images show as links in Teams | `MEDIA_PROXY_SECRET` or `PUBLIC_URL` isn't set, or `/media/slack/*` isn't forwarded by your proxy. |
| The bridge refuses to start with "newer than this build supports" | You're running an older version against an upgraded database. Upgrade, or restore the matching `.bak-v<N>` backup. |

The service logs every relay failure (look for `❌ Bridge error`). `GET /api/health` (admin) reports connection status and relay counts. `GET /api/health/live` is an unauthenticated liveness check.
