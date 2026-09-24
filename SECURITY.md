# Security & Access Control Model

This document details the permissions, data access boundaries, and operational risks of running **InterBridge**. It's meant to help organizations decide **which party (e.g., agency vs. client) should own and host the bridge**.

> **Status:** InterBridge has automated test coverage but hasn't yet been verified against a live Slack workspace and Teams tenant. Treat the platform behavior described here as the documented design, and validate it in a pilot before relying on it for sensitive work.

---

## 1. Environment Access Breakdown

### A. Microsoft Teams Environment

InterBridge uses Microsoft's **Resource-Specific Consent (RSC)** model rather than tenant-wide Microsoft Graph application permissions. It makes **no Microsoft Graph calls**.

| Permission / Mechanism | Scope | What It Can Access | What It CANNOT Access |
| :--- | :--- | :--- | :--- |
| **`ChannelMessage.Read.Group`** (RSC) | Single Team | Messages in the standard channels of the **specific Team** where the app is installed, without needing an @mention. | • Other Teams in the tenant<br>• Chats, 1:1 or group DMs<br>• Private or shared channels<br>• Mail, Calendar, OneDrive, or SharePoint |
| **Azure Bot Service** | Proactive messaging in that Team | Post, edit and delete **its own** messages (text and Adaptive Cards) in mapped channels, and download images attached to messages it receives. | Can't edit or delete messages posted by people, impersonate Teams users, or read their credentials. |
| **Consent Level Required** | **Team Owner** | A Team Owner can install the app for their own team, provided the tenant allows custom app uploads. No Microsoft 365 Global Administrator consent is needed. | N/A |

> **Teams Security Boundary**: Microsoft enforces RSC per team. Installing InterBridge in an "Acme Project" Team gives the bridge no visibility into other Teams, chats, or tenant data. File *links* from that team are relayed to Slack, but the bridge can't open SharePoint files itself; see Section 3.

### B. Slack Environment

InterBridge uses a Slack App with a bot token (`xoxb-...`), plus an app-level token (`xapp-...`) in Socket Mode.

| Scope | Purpose | Security Implication |
| :--- | :--- | :--- |
| **`channels:history`** | Read messages in public channels | Covers **public channels the bot has been added to**. The bot has no `channels:join` scope, so it can't add itself, but **any workspace member can `/invite` it** to any public channel. |
| **`groups:history`** | Read messages in private channels | The bot can only read private channels it has been explicitly invited to (`/invite @InterBridge`). |
| **`chat:write`** | Post, edit and delete its own messages | Only in channels the bot belongs to. It can't edit or delete other people's messages. |
| **`chat:write.customize`** | Custom display name & avatar | Shows the Teams sender's name and avatar on relayed messages. The message is still posted by the bot, and Slack labels it as an app. |
| **`reactions:read` & `write`** | Sync emoji reactions | Read reactions, and add or remove the bot's own. |
| **`files:read` & `write`** | Images | Download images shared in bridged channels (for the media proxy), and upload images copied from Teams. |
| **`users:read`** | Display name & avatar resolution | Reads user profiles (name, avatar, email) to attribute relayed messages. |

> **Slack Security Boundary**: Unlike Teams RSC, the Slack bot's reach is decided by channel membership, and anyone in the workspace can invite it into a public channel. The bridge only relays channels that have a configured bridge, but it still *receives* messages from every channel it's in. If a Slack organization doesn't want an external party's bot able to read public channels, **restrict it to private channels** (Section 2) or have that organization host the bridge.

---

## 2. Who Should Host the Bridge? (Agency vs. Client)

Which organization should host the InterBridge instance depends on which platform is more sensitive:

### Scenario 1: Agency is on Slack, Enterprise Client is on Microsoft Teams (Most Common)
* **Recommended Host**: **Agency**
* **Why**:
  - The client only needs to install the custom Teams app into a dedicated project Team.
  - Thanks to Teams **Resource-Specific Consent (RSC)**, Microsoft enforces that the Agency's bridge **can't** access any other client Teams, executive chats, SharePoint drives, or Outlook data.
  - The client doesn't need to manage servers, Docker containers, or Slack credentials.

### Scenario 2: Client is on Slack, Vendor/Agency is on Microsoft Teams
* **Recommended Host**: **Client** (or Agency with a restricted private-channel bot)
* **Why**:
  - A security-conscious Slack customer may not want an external party's bot that anyone can invite into public channels, so they may prefer to host InterBridge on their own infrastructure.
  - **Alternative if Agency hosts**: collaborate in a Slack **private channel**, and remove `channels:history` and the `message.channels` event from the Slack app manifest, keeping `groups:history` and `message.groups`. The bot then can't read any public channel, even if someone invites it.

---

## 3. Data Storage & Privacy

| Data Category | Stored? | Location & Retention |
| :--- | :--- | :--- |
| **Message text & sender** | **YES** | For each relayed message, the text (as sent, including any `📎` link lines) and the sender's name and avatar URL are stored in SQLite. This lets edits keep reaction footers and lets bridge-posted Teams messages be re-rendered. Deleted after `MESSAGE_RETENTION_DAYS` (default 30). |
| **Routing metadata** | **YES** | Slack channel ID + message timestamp and Teams channel ID + message ID, which power threading, edits, deletes and reactions. Same retention. |
| **Reactions** | **YES** | Who reacted with which emoji, used to count reactions and render footers and notices. Deleted with their message. |
| **Attachment metadata** | **YES** | File names, types, links, signed image-proxy URLs, and the IDs of images uploaded to Slack. **File and image contents are never written to disk**: they stream through memory. Same retention. |
| **Teams service URLs** | **YES** | The Bot Framework region endpoint for each Teams channel and team. Kept until removed. |
| **User profile cache** | **YES** | Slack display names, avatar URLs and emails, cached to avoid Slack API rate limits. Kept until overwritten. |
| **Database backups** | **YES** | Before a schema upgrade, the bridge writes `<DATABASE_PATH>.bak-v<N>` next to the database. **These backups contain the data above and are not pruned**; delete them once an upgrade is confirmed. |
| **Credentials & tokens** | **YES** | Environment variables (`.env`) hold the Slack tokens, the Azure bot secret, `ADMIN_PASSWORD` and `MEDIA_PROXY_SECRET`. Never commit `.env`. |
| **Copies on the other platform** | **YES** (by design) | Relayed messages and images copied from Teams into Slack live on in Slack and Teams under those platforms' own retention policies. Deleting the bridge doesn't remove them. |
| **Dashboard activity log** | **No** | The dashboard's activity panel only lists actions taken in that browser tab. |

---

## 4. Network Surface

Everything is served on one port (`PORT`, default 3978):

| Path | Who calls it | Authentication |
| :--- | :--- | :--- |
| `/api/messages` | Azure Bot Service (Teams) | Bot Framework JWT, validated by the SDK |
| `/slack/events` | Slack, **HTTP mode only** | Slack request signature (`SLACK_SIGNING_SECRET`) |
| `/media/slack/<token>` | Teams clients, **only if `MEDIA_PROXY_SECRET` is set** | HMAC-signed capability URL (see below) |
| `/api/health/live` | Health checks | None (returns only `{"status":"ok"}`) |
| Dashboard and all other `/api/*` | Administrators | HTTP Basic auth: any username, password `ADMIN_PASSWORD` |

**Signed image proxy (`/media/slack`)**: Teams loads card images directly from a URL, but Slack files need the bot token. So when the proxy is enabled, the bridge gives Teams a signed URL for each Slack image and fetches it on request.
- **Anyone with one of these links can view that one image**, with no expiry, so images on older messages keep working. The links are posted into your Teams channel, so treat them like the image itself.
- Rotating `MEDIA_PROXY_SECRET` revokes every link at once.
- The proxy only fetches `https://files.slack.com`, serves only raster images (no SVG), caps size at 20 MB, and sends `nosniff` and restrictive CSP headers.

**Outbound credential use**: the Teams bot token is only sent to Microsoft attachment hosts (`*.asm.skype.com`, `smba.trafficmanager.net`, `*.teams.microsoft.com`). The Slack bot token is only sent to Slack. A URL someone puts in a message can't make the bridge send either token elsewhere.

---

## 5. Hardening & Deployment Recommendations

1. **Change the default admin password**:
   - Set `ADMIN_PASSWORD` in `.env` to a strong, random secret. The bridge warns at startup if it's still `admin`.
2. **Use Slack Socket Mode**:
   - With `SLACK_USE_SOCKET_MODE=true` (the default), InterBridge opens an outbound WebSocket to Slack. **No inbound port** is needed for Slack.
3. **Expose only what's needed publicly**:
   - `/api/messages` must be public for Azure Bot Service. Add `/slack/events` only in Slack HTTP mode, and `/media/slack/*` only if you enable the image proxy.
   - Put InterBridge behind a reverse proxy (e.g. Caddy, Nginx, or Cloudflare Tunnel) with HTTPS/TLS. Consider serving the dashboard only on an internal network or VPN; it's password-protected, but it doesn't need to be public.
4. **Network isolation**:
   - With Docker Compose, keep InterBridge on an internal Docker network and expose port 3978 only to your reverse proxy.
5. **Protect the data directory**:
   - `DATABASE_PATH` (default `./data/`) holds message text for the retention period, plus any upgrade backups. Restrict access to it, include it in your backup policy deliberately, and lower `MESSAGE_RETENTION_DAYS` if you need less history. Threads, edits and reactions only work within that window.
6. **Rotate secrets** if they may have leaked: the Slack tokens, the Azure client secret, `ADMIN_PASSWORD`, and `MEDIA_PROXY_SECRET` (which also revokes existing image links).
