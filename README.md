# InterBridge: Self-Hosted Slack <-> Microsoft Teams Channel Bridge

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-v22+-green.svg)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/docker-ready-blue.svg)](Dockerfile)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-blue.svg)](tsconfig.json)

**InterBridge** is a self-hostable bridge that connects Slack channels and Microsoft Teams channels. It relays messages both ways, including threaded replies, edits, deletes, reactions, images and file-share links, without SaaS fees and without either side changing platforms.

It runs as a single Node.js service (or Docker container) with a SQLite database and a small admin dashboard.

---

## Key Features

- **Two-way messaging** between each pair of mapped Slack and Teams channels.
- **Team Owner install in Teams (Resource-Specific Consent)**: the Teams side uses `ChannelMessage.Read.Group`, which a **Team Owner** grants for one team. It doesn't need tenant-wide admin permissions such as `ChannelMessage.Read.All`.
- **Sender identity**:
  - **In Slack**, Teams messages show the sender's name and avatar (`chat:write.customize`).
  - **In Teams**, Slack messages appear as an **Adaptive Card** with the sender's avatar, or as Markdown with a `**[Slack] Jane Doe**` header. This is chosen per bridge.
- **Threads**: replies stay in the matching thread on the other side.
- **Edits & deletes**: edits and deletions on the platform where a message was written are mirrored to the other side (per-bridge toggles). Deleting the bridge's copy never deletes the original.
- **Reactions**:
  - Teams reactions appear as native Slack reactions.
  - Teams bots can't add reactions, so Slack reactions appear as a live footer on bridge-posted Teams messages (`👍 3 · 🎉 1 — reactions from Slack`).
  - Optionally, they can also appear as one self-updating thread reply on messages written in Teams.
- **Images & file links** (per-bridge toggle):
  - Images shared in Teams are copied into the relayed Slack message.
  - Slack images appear inline in Teams if you enable the optional signed media proxy (`MEDIA_PROXY_SECRET`).
  - Other files are relayed as a named `📎` link to the original, so opening one may require access on the source platform.
- **Unsupported-content alerts**: when something can't be relayed in full, the sender is told. That covers file sharing being off, a file sent only as a link, an image that couldn't be copied, and Teams cards. The alert is private in Slack and a thread reply in Teams, rate-limited, with a per-bridge toggle.
- **Loop prevention**: the bridge tracks the messages it posted and ignores its own bot accounts, so relays can't bounce back and forth.
- **Slack Socket Mode**: the bridge connects out to Slack over a WebSocket, so Slack needs no inbound port. (HTTP Events API mode is also supported.)
- **Admin dashboard**: create and remove channel bridges, see connection status and relay counts, send a test message, and download app manifests.

See [Limitations](#limitations) for what isn't supported.

---

## Architecture Overview

```
+-------------------------------------------------------------------------------+
|                             INTERBRIDGE SERVICE                               |
|                                                                               |
|   +-----------------------------------------------------------------------+   |
|   |                  HTTP server (one port, default 3978)                 |   |
|   |  Public (platform-authenticated):                                     |   |
|   |   - /api/messages      Teams Bot Framework webhook (Azure JWT)        |   |
|   |   - /slack/events      Slack Events API, HTTP mode only (signature)   |   |
|   |   - /media/slack/...   Signed Slack image proxy (opt-in)              |   |
|   |   - /api/health/live   Liveness probe                                 |   |
|   |  Admin (password):   dashboard + /api/* REST API                      |   |
|   +-----------------------------------------------------------------------+   |
|   |  Slack Socket Mode: outbound WebSocket (default)                      |   |
|   +-----------------------------------------------------------------------+   |
|                                      |                                        |
|   +-----------------------------------------------------------------------+   |
|   |                           Bridge core                                 |   |
|   |  - Routing, loop prevention, thread mapping                           |   |
|   |  - Dialect translation (Slack mrkdwn <-> Teams Markdown/HTML)         |   |
|   |  - Edits, deletes, reactions, attachments, sender notices             |   |
|   +-----------------------------------------------------------------------+   |
|                                      |                                        |
|   +-----------------------------------------------------------------------+   |
|   |                     SQLite (WAL, versioned migrations)                |   |
|   |  - Channel bridges and their options                                  |   |
|   |  - Message pairs, incl. message text for re-rendering (pruned)        |   |
|   |  - Reactions, Teams service URLs, user profile cache                  |   |
|   +-----------------------------------------------------------------------+   |
+-------------------------------------------------------------------------------+
```

---

## Quickstart

### 1. Prerequisites
- Node.js 22+, or Docker
- A Slack workspace where you can create an app
- A Microsoft Teams team where you are a **Team Owner**, in a tenant that allows custom app uploads
- An Azure Bot registration (the free F0 tier is enough)
- A public HTTPS URL for the bridge. Teams has to reach `/api/messages`; a reverse proxy or Cloudflare Tunnel works.

### 2. Configure

```bash
cp .env.example .env
```

At minimum, set these (every setting is listed in the [setup guide](docs/setup_guide.md#4-environment-configuration)):

```env
PUBLIC_URL=https://bridge.example.com
ADMIN_PASSWORD=change-me-to-something-long

SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

TEAMS_APP_ID=your-azure-bot-app-id
TEAMS_APP_PASSWORD=your-azure-bot-client-secret
TEAMS_TENANT_ID=your-microsoft-tenant-id
TEAMS_APP_TYPE=SingleTenant
```

The [setup guide](docs/setup_guide.md) walks through creating the Slack app, the Azure Bot and the Teams app package.

### 3. Run with Docker Compose

```bash
docker compose up -d
```

Open `http://localhost:3978`. Your browser will prompt for credentials: any username works, and the password is `ADMIN_PASSWORD`. The service has to be publicly reachable for Teams, so use a strong password.

### 4. Or run with Node.js

```bash
npm install
npm run build
npm start
```

---

## Security & Data

- **Microsoft Teams**: installed per team with Resource-Specific Consent. The bridge only receives messages from standard channels of the teams it's installed in.
- **Slack**: standard bot scopes. The bot reads the channels it's a member of, and any workspace member can invite it to a public channel. If that's too broad, bridge private channels only. [SECURITY.md](SECURITY.md) explains how.
- **Stored data**: the database keeps **message text and sender names** for relayed messages, so edits and reaction footers can re-render them. It also keeps message ID pairs, reactions and attachment metadata. These are deleted after `MESSAGE_RETENTION_DAYS` (default 30). Image and file contents are never written to disk.

For the full permission breakdown, the public endpoints, and guidance on which organization should host the bridge, see **[SECURITY.md](SECURITY.md)**.

---

## Limitations

- **Non-image files aren't copied**: they're relayed as links. Copying them would require Microsoft Graph with admin consent; see [#24](https://github.com/georgestephanis/slack-teams-interop/issues/24).
- **Slack reactions can't appear as native Teams reactions**, because Bot Framework has no API for a bot to react. They're shown as a footer or a thread notice instead.
- **Teams cards** (Adaptive, hero, and so on) aren't relayed to Slack; the sender is told.
- **Custom Slack emoji** render as `:name:` in Teams.
- **Only standard Teams channels** are supported, not private or shared channels, chats, or 1:1 messages.
- **Existing bridges can't be edited in the dashboard** yet: delete one and create it again to change its options.
- The Matrix event converters in `src/adapters/matrix/` are groundwork only. **Matrix isn't bridged.**

---

## Documentation

- **[Setup & Deployment Guide](docs/setup_guide.md)**: Slack app, Azure Bot, Teams app package, configuration reference, and troubleshooting.
- **[Security & Access Control Model](SECURITY.md)**: permissions, data storage, public endpoints, and hosting guidance.
- **[AGENTS.md](AGENTS.md)**: architecture, invariants and conventions for anyone (human or agent) changing the code.
- **[Implementation Plan](docs/implementation_plan.md)**: the original feasibility study and design reasoning (historical).

---

## Development

```bash
npm run dev        # run with auto-reload
npm test           # vitest
npx tsc --noEmit   # typecheck
```

The test suite covers dialect translation, loop prevention, threading, edits and deletes, reactions, attachments, migrations, and the HTTP endpoints. It uses mock adapters, so it never contacts Slack or Teams.

---

## License

MIT
