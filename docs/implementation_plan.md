# Feasibility Investigation & Implementation Plan: Self-Hosted Slack <-> Microsoft Teams Channel Bridge

This document provides a comprehensive analysis of the Slack and Microsoft Teams API ecosystems, evaluates feasibility, investigates the Matrix.org common-bus approach, and outlines the complete technical architecture and user experience plan for a reliable, self-hosted bridging service.

---

## 1. Executive Summary & Feasibility

### Is it feasible to build a self-hosted alternative to SlackBridge?
**Yes, entirely feasible.** Both Slack and Microsoft Teams provide official developer APIs that support real-time two-way messaging, threaded replies, reactions, and file transfers. 

### Why SlackBridge and commercial alternatives charge $50–$200+/month:
1. **The Microsoft 365 Permission Hurdle**: Microsoft Graph has restrictive tenant-level permissions (`ChannelMessage.Read.All`) that trigger enterprise IT security alarms. Getting around this cleanly requires using **Resource-Specific Consent (RSC)** via a Microsoft Teams Bot, which limits app scope strictly to the specific Team consented by the team owner.
2. **Formatting & Mention Translation**: Slack and Teams use different Markdown dialects, different emoji formats, and incompatible user mention models.
3. **Loop & Echo Prevention**: When platform A relays to platform B, platform B's event listener must not echo the relayed message back to platform A.
4. **Cross-Platform Thread Resolution**: Mapping Slack timestamps (`1711200000.123456`) to Teams GUID/timestamp message IDs across asynchronous reply chains.

---

## 2. Architectural Comparison: Direct Bridge vs. Matrix.org

The user highlighted an interest in using **Matrix.org** as a common merge system. Here is a clear breakdown of the two architectural paths:

```
[Option A: Direct Relay Engine]
+---------------+         Direct HTTPS / Webhook        +-------------------+
|  Slack App    | <===================================> |   Teams App / Bot |
| (Bolt/Events) |      (Node.js/TypeScript Bridge)      | (Bot Framework SDK)|
+---------------+                  |                    +-------------------+
                             SQLite / Redis
                           (ID Map & Metadata)

[Option B: Matrix Common Hub]
+---------------+       Appservice        +-----------------+      Teams Bridge      +-------------------+
|  Slack App    | <=====================> | Matrix Server   | <====================> |   Teams App / Bot |
|               | (matrix-appservice-slack|(Synapse/Conduit)| (mautrix-teams/custom) |                   |
+---------------+                         +-----------------+                        +-------------------+
```

### Option A: Dedicated Direct Bridge (Recommended for Simplicity & Enterprise Teams)
- **How it works**: A single lightweight container running Node.js/TypeScript (or Go). Listens to Slack Events API (or Socket Mode) and Teams Bot Framework Webhook, converts payloads directly, and maps message IDs in an embedded SQLite database.
- **Pros**:
  - **Single container**: Can run on a $5/mo VPS or internal server with minimal RAM (< 150 MB).
  - **Zero latency overhead**: Direct event-to-API forwarding (< 500ms).
  - **Full control over Teams Enterprise RSC**: Can natively implement Microsoft Teams Bot Framework v4 and Resource-Specific Consent (`ChannelMessage.Read.Group`).
  - **High-fidelity features**: Custom Slack user impersonation (`chat:write.customize`) and native Teams Adaptive Cards.
- **Cons**:
  - Point-to-point (bridges Slack and Teams specifically, not Discord/IRC/Matrix clients).

### Option B: Matrix.org as the Canonical Common Bus
- **How it works**: A Matrix homeserver (e.g., Conduit or Synapse) acts as the central hub. Slack channels plumb into a Matrix room via `matrix-appservice-slack` (or `matrix-hookshot`). Teams channels plumb into the same Matrix room.
- **Pros**:
  - **Extensible**: Allows Matrix users (Element clients) or other networks (Discord, IRC) to join the same conversation.
  - **Canonical open standard**: Messages are stored as standard Matrix `m.room.message` events.
  - **Battle-tested Slack bridge**: `matrix-appservice-slack` is mature and maintained by Matrix.org / Element.
- **Cons & Reality on the Teams Side**:
  - **The "Teams Bridge" bottleneck**: There is currently **no mature, turnkey open-source Matrix bridge for Enterprise Microsoft Teams** with RSC and tenant Graph auth. The Element Teams bridge (`matrix-appservice-teams`) is closed-source enterprise software sold via Element Matrix Services (EMS). `mautrix-teams` is experimental and primarily targets consumer Microsoft accounts (`teams.live.com`).
  - **Operational footprint**: Requires running a Matrix homeserver, PostgreSQL, the Slack Appservice, the Teams Appservice, and media stores.
  - **Double-hop edge cases**: Threading, reactions, and edits must be translated twice (Slack -> Matrix -> Teams, and Teams -> Matrix -> Slack), increasing metadata loss.

### Recommendation
**A Hybrid / Dual-Capable Architecture**:
Build the direct, lightweight Slack <-> Teams bridge core (giving immediate enterprise reliability, low latency, and single-binary deployment), while adhering to a **Matrix-inspired normalized event schema** internally. Provide an optional Matrix Appservice adapter so that the bridge can also plumb into a Matrix homeserver if desired.

---

## 3. Deep Dive: Microsoft Teams & Slack APIs

### A. Microsoft Teams Ecosystem

| Aspect | Technical Details & Feasibility |
| :--- | :--- |
| **Ingestion (Receiving Messages)** | **Teams Bot Activity Handler with RSC** (`ChannelMessage.Read.Group`).<br>• Does *not* require @mentioning the bot.<br>• Declared in Teams App Manifest under `authorization.permissions.resourceSpecific`.<br>• Team owner consents when adding the app to a Team.<br>• *Avoids* the dreaded tenant-wide `ChannelMessage.Read.All` which requires Global Admin consent and Graph compliance licensing. |
| **Outbound (Sending to Teams)** | **Bot Framework SDK (`botbuilder`)** or Graph API.<br>• Bot posts an `Activity` to the channel conversation.<br>• For threaded replies: specify `replyToId: <teams_parent_message_id>`. |
| **Sender Identity / Visuals** | Microsoft Teams bots cannot change their display name or profile picture dynamically per message (they always appear under the Bot's App name).<br>**Solution**: Send an **Adaptive Card** with the Slack user's avatar, name, and timestamp, or a clean Markdown header: `**[Slack] Jane Doe**: <message>`. |
| **Reactions** | Received via `messageReaction` activity in Bot Framework (`activity.reactionsAdded`, `activity.reactionsRemoved`). Sent to Teams via Graph API `POST /chats/{chat-id}/messages/{message-id}/hostedContents` or reactions endpoint. |
| **File Attachments** | Files in Teams channel messages are stored in the Team's SharePoint site. The bridge receives file attachment metadata in the activity (`activity.attachments`), obtains a download URL via Graph API, and forwards it to Slack. |
| **Hosting Requirement** | Azure Bot Service registration (Free F0 Tier, unlimited messages). Requires a public HTTPS endpoint (e.g., via Cloudflare Tunnel, Caddy with Let's Encrypt, or standard reverse proxy). |

### B. Slack Ecosystem

| Aspect | Technical Details & Feasibility |
| :--- | :--- |
| **Ingestion (Receiving Messages)** | **Slack Bolt SDK / Events API** or **Socket Mode**.<br>• Subscribes to `message.channels`, `message.groups` (private channels), `reaction_added`, `reaction_removed`.<br>• **Socket Mode**: Enables bidirectional communication over WebSocket, eliminating the need to expose a public port or reverse proxy for Slack! |
| **Outbound (Sending to Slack)** | `chat.postMessage` via Slack Web API.<br>• For threaded replies: specify `thread_ts: <slack_parent_ts>`. |
| **Sender Identity / Visuals** | **Near-perfect UX**: With the `chat:write.customize` scope, the bridge bot can dynamically supply `username: "John Smith (Teams)"` and `icon_url: "https://avatar-url"` on every message. Messages look native in Slack. |
| **Reactions** | Handled natively via `reactions.add` and `reactions.remove`. |
| **File Attachments** | Upload files to Slack using `files.uploadV2`. Stream downloaded files directly from Teams to avoid persistent disk storage. |

---

## 4. Message Normalization, Threading & Loop Prevention

### 1. Loop Prevention (Echo Cancelling)
To prevent infinite bounce loops:
1. **Bot ID Filtering**:
   - In Slack: Ignore messages where `event.bot_id` matches the bridge's Slack Bot ID or `subtype === 'bot_message'`.
   - In Teams: Ignore activities where `activity.from.id` matches the bridge's Microsoft App ID.
2. **Relayed Message Hash Cache**:
   - Maintain a 60-second in-memory LRU cache of outgoing message hashes (or client-assigned IDs) across both channels.

### 2. Thread Mapping Table
A bi-directional mapping stored in SQLite / PostgreSQL with a configurable TTL (e.g., 14–30 days):

```sql
CREATE TABLE message_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mapping_id TEXT NOT NULL,         -- ID of the channel pair configuration
    slack_channel_id TEXT NOT NULL,
    slack_message_ts TEXT NOT NULL,
    teams_team_id TEXT NOT NULL,
    teams_channel_id TEXT NOT NULL,
    teams_message_id TEXT NOT NULL,
    is_thread_root BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_slack_lookup ON message_mappings (slack_channel_id, slack_message_ts);
CREATE INDEX idx_teams_lookup ON message_mappings (teams_channel_id, teams_message_id);
```

**Thread Routing Logic**:
- **Slack -> Teams**: If `event.thread_ts` is present, look up the corresponding `teams_message_id` for that `thread_ts`. If found, send the Teams activity with `replyToId = teams_message_id`. If not found, start a new thread or post as root.
- **Teams -> Slack**: If `activity.replyToId` is present, look up the corresponding `slack_message_ts` for that `replyToId`. If found, post to Slack with `thread_ts = slack_message_ts`.

### 3. Markdown Dialect Translation

| Element | Slack Syntax | Teams Syntax |
| :--- | :--- | :--- |
| **Bold** | `*text*` | `**text**` |
| **Italic** | `_text_` | `*text*` |
| **Strikethrough** | `~text~` | `~~text~~` |
| **Links** | `<https://url\|Text>` | `[Text](https://url)` |
| **Inline Code** | `` `code` `` | `` `code` `` |
| **Blockquote** | `> quote` | `> quote` |
| **User Mentions** | `<@U123456>` | `<at>User Name</at>` with Mention Entity |

---

## 5. System Architecture & Proposed Tech Stack

```
+-------------------------------------------------------------------------------+
|                       SELF-HOSTED BRIDGE SERVICE                              |
|                                                                               |
|   +-----------------------------------------------------------------------+   |
|   |                       Web & Ingress Layer                             |   |
|   |  - Fastify / Express (REST API + Teams Webhook /api/messages)         |   |
|   |  - Slack Bolt (HTTP or WebSocket Socket Mode)                         |   |
|   |  - Web Admin Dashboard (Vite + React / Modern CSS)                    |   |
|   +-----------------------------------------------------------------------+   |
|                                      |                                        |
|   +-----------------------------------------------------------------------+   |
|   |                       Core Engine & Adapters                          |   |
|   |  - Normalizer / Markdown Converter                                    |   |
|   |  - Identity & Avatar Resolver                                         |   |
|   |  - Thread Router & Loop Filter                                        |   |
|   |  - Async Queue (P-Queue / BullMQ) for rate-limit resilience           |   |
|   +-----------------------------------------------------------------------+   |
|                                      |                                        |
|   +-----------------------------------------------------------------------+   |
|   |                       State & Persistence Layer                       |   |
|   |  - SQLite (WAL mode) / PostgreSQL (Drizzle ORM)                       |   |
|   |  - Message ID Mappings (TTL expired)                                  |   |
|   |  - Channel Pair Configurations & Credentials                          |   |
|   +-----------------------------------------------------------------------+   |
+-------------------------------------------------------------------------------+
```

### Recommended Technology Stack:
1. **Runtime**: Node.js 20+ / TypeScript.
2. **Slack Integration**: `@slack/bolt` (supports both Events HTTP endpoint and Socket Mode).
3. **Teams Integration**: `botbuilder` (Microsoft Bot Framework SDK v4) with `TeamsActivityHandler`.
4. **Database**: SQLite with `better-sqlite3` and `drizzle-orm` (zero external DB maintenance, single-file backup, 100k+ ops/sec in WAL mode). Option to switch to PostgreSQL via connection string.
5. **Admin Web UI**: Lightweight React / Tailwind or vanilla CSS dashboard with authentication to manage channel mappings, test connections, and inspect live message health.
6. **Deployment**: Single Docker container (`docker-compose.yml`) with persistent volume for SQLite database and config.

---

## 6. User Experience & Management Workflow

### Phase 1: One-Time App Setup
1. **Slack App Creation**:
   - Provide a pre-built `slack-manifest.json` / `manifest.yaml`.
   - Admin pastes it into [api.slack.com/apps](https://api.slack.com/apps) -> App created with all scopes (`chat:write`, `chat:write.customize`, `channels:history`, `files:write`, etc.) in 30 seconds.
2. **Teams App Creation**:
   - Provide a packaged `teams-app.zip` (containing `manifest.json` with RSC `ChannelMessage.Read.Group` and high-res app icons).
   - In Azure: create a free Azure Bot resource (F0 tier) -> obtain `MicrosoftAppId` and `MicrosoftAppPassword`.
   - In Teams: Team owner uploads custom app to the Team (or admin approves it).

### Phase 2: Channel Mapping in the Admin UI
The Admin Web UI provides a clean 3-step setup:
1. **Add Connection**:
   - Input Slack Bot Token & Signing Secret (or App-Level Token for Socket Mode).
   - Input Microsoft App ID, App Password, and Tenant ID.
2. **Map Channels**:
   - Select Slack channel (e.g., `#client-sync`).
   - Select Teams Team & Channel (e.g., `Partner Projects > General`).
   - Configure sync options (Sync Edits: ON, Sync Deletions: ON, File Transfer: ON, Display Format: Adaptive Card vs. Clean Markdown).
3. **Verify & Health Check**:
   - The UI runs an automated diagnostic: sends a test payload both ways and confirms acknowledgment in < 2 seconds.

---

## 7. Open Questions & Design Decisions for User Review

> [!IMPORTANT]
> **Key Architecture Decisions to Align On:**

1. **Direct Bridge vs. Matrix-First**:
   - *Option A (Recommended)*: Build the direct, lightweight Slack <-> Teams bridge in Node/TypeScript. It delivers lower latency, zero Matrix server operational overhead, and full support for Microsoft Teams Resource-Specific Consent (RSC).
   - *Option B (Matrix-Centric)*: Stand up a Matrix homeserver (Conduit/Synapse) + `matrix-appservice-slack`. Because there is no production-grade open-source Matrix bridge for Enterprise Microsoft Teams with RSC, we would still need to build the Matrix <-> Teams bridge component ourselves.
   - *User Preference*: Which route fits your operational model better?

2. **Slack Connection Mode (Socket Mode vs. HTTP Webhook)**:
   - Would you prefer **Slack Socket Mode** (which runs over a secure outbound WebSocket, requiring NO public IP or firewall holes for Slack), or standard **HTTP Webhooks**?

3. **Teams Message Aesthetics**:
   - In Teams, when a Slack message arrives, would you prefer:
     - **Option 1**: A clean Markdown format with sender prefix: `**[Slack] Alex Doe**: Hey team, quick update...` (Supports native text selection and mobile quoting).
     - **Option 2**: An **Adaptive Card** with the user's avatar image, badge, and formatted body (more visually distinct, looks like a rich enterprise integration).
     - *Or configurable per channel?*

---

## 8. Verification & Rollout Plan

### Automated Testing
- **Unit Tests**:
  - Markdown dialect conversion (Slack mrkdwn <-> Teams CommonMark/HTML).
  - Loop detection & hash deduplication.
  - Thread ID resolution logic.
- **Integration Tests (Mock Harness)**:
  - Simulate Slack Events API payload -> verify generated Bot Framework Activity.
  - Simulate Teams Bot Activity -> verify Slack `chat.postMessage` payload and thread parameters.

### Live Pilot Testing
- Deploy to test environment.
- Create test channel `#bridge-test` in Slack and `Bridge Test` in Teams.
- Test root messages, nested replies (threads), user mentions, emojis/reactions, and image attachments.
