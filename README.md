# InterBridge: Self-Hosted Slack <-> Microsoft Teams Channel Bridge

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-v20+-green.svg)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/docker-ready-blue.svg)](Dockerfile)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](tsconfig.json)

**InterBridge** is an enterprise-ready, self-hostable bridge connecting Slack and Microsoft Teams channels with real-time two-way messaging, threaded replies, reactions, and file transfers — without paying SaaS fees or migrating either platform.

---

## Key Features

- **Real-Time Two-Way Messaging**: Sub-second synchronization between mapped Slack channels and Microsoft Teams channels.
- **Resource-Specific Consent (RSC)**: Solves the enterprise security barrier. Requires only **Team Owner** consent in Microsoft Teams (using `ChannelMessage.Read.Group`), completely bypassing the need for tenant-wide Global Admin privileges (`ChannelMessage.Read.All`).
- **Seamless User Identity Mirroring**:
  - **In Slack**: Teams messages arrive showing the sender's real name and avatar (`chat:write.customize`), looking like native participants.
  - **In Teams**: Slack messages display in clean Markdown (`**[Slack] Jane Doe**: ...`) or sleek **Adaptive Cards** with avatar badges.
- **Bi-Directional Thread Continuity**: Parent/child reply hierarchies are preserved across both platforms via SQLite message ID mapping.
- **Echo & Loop Prevention**: Real-time content hashing and bot ID filtering prevent infinite relay loops.
- **Zero Inbound Ports for Slack (Socket Mode)**: Connects to Slack via secure outbound WebSocket. Only the Teams Bot Framework endpoint needs public HTTPS access (compatible with Cloudflare Tunnel, Caddy, or standard reverse proxies).
- **Matrix.org Protocol Compatibility**: Uses a protocol-neutral normalized event model inspired by Matrix `m.room.message` events.
- **Modern Web Admin Dashboard**: Sleek dark-mode management UI to create channel bridges, monitor live message feeds, run diagnostic tests, and download app manifests.

---

## Architecture Overview

```
+-------------------------------------------------------------------------------+
|                             INTERBRIDGE SERVICE                               |
|                                                                               |
|   +-----------------------------------------------------------------------+   |
|   |                       Ingress & Webhook Layer                         |   |
|   |  - Teams Bot Framework Endpoint (/api/messages)                       |   |
|   |  - Slack Socket Mode (WebSocket) or HTTP Events API                   |   |
|   |  - Admin Dashboard & REST API (Port 3978)                             |   |
|   +-----------------------------------------------------------------------+   |
|                                      |                                        |
|   +-----------------------------------------------------------------------+   |
|   |                       Core Orchestrator                               |   |
|   |  - Dialect Translator (Slack mrkdwn <-> Teams CommonMark/HTML)        |   |
|   |  - Deduplication & Echo Manager (LRU Hash Cache)                      |   |
|   |  - Thread Mapper (Parent/Child Resolution)                            |   |
|   |  - Matrix Protocol Adapter (m.room.message schema)                    |   |
|   +-----------------------------------------------------------------------+   |
|                                      |                                        |
|   +-----------------------------------------------------------------------+   |
|   |                       State & Persistence                             |   |
|   |  - SQLite WAL Database (channel mappings & message ID pairs)          |   |
|   |  - User Identity & Avatar Cache                                       |   |
|   +-----------------------------------------------------------------------+   |
+-------------------------------------------------------------------------------+
```

---

## Quickstart

### 1. Prerequisites
- Node.js 20+ or Docker
- A Slack workspace with permission to create an app
- A Microsoft Teams tenant where you are a Team Owner
- A free Azure Bot Service registration (F0 Tier)

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

```env
# Server
PORT=3978
DATABASE_PATH=./data/bridge.sqlite

# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_USE_SOCKET_MODE=true

# Microsoft Teams / Azure Bot
TEAMS_APP_ID=your-azure-bot-app-id
TEAMS_APP_PASSWORD=your-azure-bot-app-secret
TEAMS_TENANT_ID=your-microsoft-tenant-id
```

### 3. Run with Docker Compose

```bash
docker compose up -d
```

Open `http://localhost:3978` in your browser to access the Admin Dashboard!

### 4. Or Run Locally

```bash
npm install
npm run build
npm start
```

---

## Security & Environment Access Boundaries

InterBridge is designed with the principle of least privilege, but platform permission architectures differ:

- **Microsoft Teams (Strict Isolation)**: Uses **Resource-Specific Consent (RSC)** with `ChannelMessage.Read.Group`. The app is consented by the Team Owner for a **single Team**. It cannot read messages from other Teams, private channels, 1:1 DMs, Outlook, or SharePoint drives across the tenant.
- **Slack (Workspace Visibility)**: Uses standard Slack Bot scopes. Note that `channels:history` allows read access across public channels in the workspace. If strict isolation is required on the Slack side, **restrict the bot to a private channel** (using only `groups:history`) or have the Slack-side organization host the bridge.
- **Data Privacy**: Message body text is processed strictly in-memory and **never written to disk or database**. Only message ID mapping metadata is persisted for thread routing and pruned automatically.

For complete access breakdown, threat models, and hosting ownership guidelines (Agency vs. Client), see **[SECURITY.md](SECURITY.md)**.

---

## Documentation

- **[Security & Access Control Model](SECURITY.md)**: Permissions breakdown, data boundaries, and hosting ownership guide (Agency vs. Client).
- **[Implementation Plan & Feasibility Study](docs/implementation_plan.md)**: Deep dive into the API ecosystems, Matrix federation analysis, and design decisions.
- **[Setup & Deployment Guide](docs/setup_guide.md)**: Step-by-step guide to generating Slack manifests, Azure Bot configuration, and Teams app packaging.

---

## Testing

InterBridge includes comprehensive automated test coverage for dialect translation, loop prevention, database mapping, and end-to-end routing simulation:

```bash
npm test
```

---

## License

MIT
