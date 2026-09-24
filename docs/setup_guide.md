# InterBridge Setup & Deployment Guide

This guide walks you through setting up your self-hosted Slack <-> Microsoft Teams bridge.

---

## 1. Prerequisites
- A **Slack Workspace** where you can create apps (or Admin privileges).
- A **Microsoft 365 Tenant** where you are a Team Owner of the target team (or have permission to add custom apps).
- An **Azure Account** (Free tier is sufficient for Azure AI Bot Service F0).
- Docker or Node.js 22+ installed on your server.

---

## 2. Slack Setup (30 Seconds)

1. Navigate to [api.slack.com/apps](https://api.slack.com/apps).
2. Click **Create New App** -> Select **From an app manifest**.
3. Choose your workspace, then paste the contents of [`manifests/slack/manifest.json`](../manifests/slack/manifest.json).
4. Review the scopes:
   - `chat:write`, `chat:write.customize` (for sender display names & avatars)
   - `channels:history`, `groups:history`, `files:read`, `files:write`, `reactions:read`, `reactions:write`, `users:read`.
5. Click **Create**, then click **Install to Workspace** and authorize it.
6. Generate an **App-Level Token** for Socket Mode:
   - In App Settings -> **Basic Information** -> **App-Level Tokens** -> Click **Generate Token and Scopes**.
   - Name it `interbridge-socket`, add the `connections:write` scope, and copy the token (`xapp-...`).
7. Copy your **Bot User OAuth Token** (`xoxb-...`) from **OAuth & Permissions**.

---

## 3. Microsoft Teams Setup (Resource-Specific Consent)

To avoid requiring tenant-wide Global Admin privileges, InterBridge uses **Resource-Specific Consent (RSC)**.

### Step 3.1: Create Azure Bot Registration (Free F0 Tier)
1. Go to the [Azure Portal](https://portal.azure.com/).
2. Search for **Azure AI Bot Service** -> Click **Create**.
3. Fill in:
   - **Bot handle**: `interbridge-bot` (or unique name)
   - **Pricing tier**: `Free F0` (unlimited standard messages)
   - **Creation type**: Multi-tenant
4. Once created, go to **Configuration**:
   - Set **Messaging endpoint**: `https://<your-public-domain>/api/messages`
   - Copy the **Microsoft App ID** (Client ID).
   - Under **Manage Password**, create a new Client Secret and copy the **Value**.
5. Under **Channels** in the Bot menu:
   - Click the **Microsoft Teams** channel icon and agree to the Terms of Service to enable the Teams channel.

### Step 3.2: Package and Install Teams App
1. Edit [`manifests/teams/manifest.json`](../manifests/teams/manifest.json) and replace `"YOUR_AZURE_BOT_APP_ID"` with your actual Microsoft App ID from Step 3.1.
2. Create a zip package containing:
   - `manifest.json`
   - `color.png`
   - `outline.png`
   *(Or run `npm run package:teams`)*
3. In Microsoft Teams:
   - Go to the Team you want to bridge.
   - Click **... (More options)** next to the Team name -> **Manage team** -> **Apps** -> **Upload a custom app** (or Upload to tenant catalog).
   - Select the zip file.
   - Click **Add**. The Team Owner consents to the `ChannelMessage.Read.Group` permission for this team.

---

## 4. Environment Configuration

Create a `.env` file in the root directory:

```env
# Server
PORT=3978
HOST=0.0.0.0
DATABASE_PATH=./data/bridge.sqlite

# Slack
SLACK_BOT_TOKEN=xoxb-your-slack-bot-token
SLACK_APP_TOKEN=xapp-your-slack-app-token
SLACK_USE_SOCKET_MODE=true

# Microsoft Teams / Azure Bot
TEAMS_APP_ID=your-azure-bot-app-id
TEAMS_APP_PASSWORD=your-azure-bot-app-secret
TEAMS_TENANT_ID=your-microsoft-tenant-id
TEAMS_SERVICE_URL=https://smba.trafficmanager.net/amer/
```

> **About `TEAMS_SERVICE_URL`:** Bot Framework routes proactive posts through a region-specific service URL. The bridge learns the correct URL from the first activity it receives from a team (installing the app counts), and stores it in the database. `TEAMS_SERVICE_URL` is only a fallback for channels it hasn't heard from yet. If your tenant is outside the Americas, set it to your region's endpoint (for example `https://smba.trafficmanager.net/emea/` or `.../apac/`). The dashboard flags mappings whose Teams channel hasn't been seen yet.

---

## 5. Running the Service

### Option A: Running with Docker Compose (Recommended)

```bash
docker compose up -d
```

Access the Admin Dashboard at `http://localhost:3978`.

### Option B: Running Locally

```bash
# Install dependencies
npm install

# Start in development mode with auto-reload
npm run dev

# Or build and run for production
npm run build
npm start
```

---

## 6. Configuring Channel Mappings

1. Open `http://localhost:3978` in your browser.
2. Click **Add Channel Bridge**:
   - **Bridge Name**: e.g., `Client Alpha Sync`
   - **Slack Channel ID**: Right-click your Slack channel -> Copy link (the ID is the final segment, e.g. `C0123456789`).
   - **Teams Channel ID**: In Teams, click `...` next to the channel -> Get link to channel (the ID is between `/channel/` and the channel name).
   - **Teams Display Style**: Choose **Adaptive Card** (rich badge) or **Clean Markdown** (`**[Slack] User**: text`).
   - **Options**: Select whether to sync threads, reactions, and files.
3. Click **Save Bridge**.
4. Send a message in either channel — it will mirror across in real time!
