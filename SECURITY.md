# Security & Access Control Model

This document details the exact permissions, data access boundaries, and operational risks associated with running **InterBridge**, specifically to help organizations decide **which party (e.g., agency vs. client) should own and host the interface layer**.

---

## 1. Environment Access Breakdown

### A. Microsoft Teams Environment

InterBridge uses Microsoft's **Resource-Specific Consent (RSC)** model rather than tenant-wide Graph application permissions.

| Permission / Mechanism | Scope | What It Can Access | What It CANNOT Access |
| :--- | :--- | :--- | :--- |
| **`ChannelMessage.Read.Group`** (RSC) | Single Team | All messages sent within standard channels of the **specific Team** where the app is installed. | • Other Teams in the tenant<br>• Direct Messages (1:1 / Group DMs)<br>• Private or Shared channels without app installation<br>• Mail, Calendar, OneDrive, or SharePoint sites outside the team |
| **Azure Bot Service** | Outbound Proactive Messaging | Post formatted messages and Adaptive Cards to mapped channels within that Team. | Cannot impersonate native Teams user accounts or access user credential tokens. |
| **Consent Level Required** | **Team Owner** | A Team Owner can install the app for their specific team without requiring a Microsoft 365 Global Administrator. | N/A |

> **Teams Security Boundary**: The blast radius in Microsoft Teams is strictly isolated to the specific Team where the app is installed. Installing InterBridge in an "Acme Project" Team gives the bridge zero visibility into any other company communications or tenant data.

---

### B. Slack Environment

InterBridge uses a Slack App with Bot Token permissions (`xoxb-...`) and optional Socket Mode (`xapp-...`).

| Scope | Purpose | Security Implication |
| :--- | :--- | :--- |
| **`channels:history`** | Read messages in public channels | **High Visibility**: In Slack, `channels:history` allows a bot to view messages in public channels across the workspace once invited or joined. |
| **`groups:history`** | Read messages in private channels | **Strict Boundary**: The bot can **only** read private channels if a human explicitly invites the bot (`/invite @InterBridge`). |
| **`chat:write`** | Post messages to channels | Allows posting messages to channels the bot belongs to. |
| **`chat:write.customize`** | User impersonation / display name & avatar | Allows the bot to display the Teams user's name and avatar on bridged messages. |
| **`reactions:read` & `write`** | Sync emoji reactions | Read and add emoji reactions to messages. |
| **`files:read` & `write`** | Sync file attachments | Read and upload attachments in channels where the bot is a member. |
| **`users:read`** | Display name & avatar resolution | Reads user profiles (name, avatar, email) to display proper attribution. |

> **Slack Security Boundary**: Unlike Teams RSC, Slack bot tokens with `channels:history` have workspace-wide public channel access. If a client is on Slack and does not want an external party's bridge to have access to public channels, **the bot should be restricted to private channels** (using only `groups:history`) or the client should host the bridge themselves.

---

## 2. Who Should Host the Bridge? (Agency vs. Client)

Deciding which organization owns and hosts the InterBridge instance depends on which platform is more sensitive:

### Scenario 1: Agency is on Slack, Enterprise Client is on Microsoft Teams (Most Common)
* **Recommended Host**: **Agency**
* **Why**:
  - The client only needs to install the custom Teams app into a dedicated project Team.
  - Thanks to Teams **Resource-Specific Consent (RSC)**, the client's IT department has cryptographic assurance that the Agency's bridge **cannot** access any other client Teams, executive chats, SharePoint drives, or Outlook data.
  - The client does not need to manage servers, Docker containers, or Slack credentials.

### Scenario 2: Client is on Slack, Vendor/Agency is on Microsoft Teams
* **Recommended Host**: **Client** (or Agency with a restricted private-channel bot)
* **Why**:
  - Because Slack bot tokens can theoretically read public channels if invited, a security-conscious Slack customer may prefer to host InterBridge within their own infrastructure.
  - **Alternative if Agency hosts**: In Slack, create a **Private Channel** for the collaboration and only grant `groups:history` (removing `channels:history`). The bot will be mathematically incapable of seeing any public Slack discussions.

---

## 3. Data Storage & Privacy

| Data Category | Stored Locally? | Location & Retention |
| :--- | :--- | :--- |
| **Message Text & Bodies** | **NO** | Message bodies are processed in-memory and immediately relayed. **No message content is ever written to disk or database.** |
| **Routing Metadata** | **YES** | Slack Channel ID + Timestamp and Teams Channel ID + Message ID are stored in SQLite (`bridge.sqlite`) to enable thread continuity and reaction routing. Automatically pruned after `MESSAGE_RETENTION_DAYS` (default 30 days). |
| **User Profile Cache** | **YES** | Display names and avatar URLs are cached in SQLite to prevent rate-limiting against Slack and Graph APIs. |
| **Credentials & Tokens** | **YES** | Environment variables (`.env`) hold Slack tokens and Azure bot secrets. Never committed to source control. |
| **Audit Log** | **In-Memory** | Live bridge feed is maintained in-memory for the web admin dashboard. |

---

## 4. Hardening & Deployment Recommendations

1. **Change the Default Admin Password**:
   - Always configure `ADMIN_PASSWORD` in your `.env` with a strong, random secret. The server enforces authentication on all management and REST endpoints.
2. **Use Slack Socket Mode**:
   - Running with `SLACK_USE_SOCKET_MODE=true` establishes an outbound WebSocket from InterBridge to Slack. **Zero inbound ports** need to be opened for Slack.
3. **Protect the Teams Webhook Endpoint**:
   - Only `/api/messages` needs public ingress (for Azure Bot Service).
   - Place InterBridge behind a reverse proxy (e.g. Caddy, Nginx, or Cloudflare Tunnel) with HTTPS/TLS.
   - Azure Bot Service signs all requests with JWT tokens validated by the Bot Framework SDK.
4. **Network Isolation**:
   - If running via Docker Compose, keep InterBridge on an internal Docker network, binding only port 3978 to your reverse proxy.
