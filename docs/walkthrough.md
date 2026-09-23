# Walkthrough: Self-Hosted Slack <-> Microsoft Teams Channel Bridge

We have designed, investigated, and implemented **InterBridge**, a self-hosted, enterprise-ready service that links Slack and Microsoft Teams for shared channels with two-way messaging, threading, reactions, and file support.

---

## 1. What Was Created

### A. Core Architecture (`src/core/`)
- **[types.ts](../src/core/types.ts)**: Protocol-neutral normalized event model inspired by Matrix.org's event schema (`m.room.message`, `m.reaction`, `m.relates_to`).
- **[translator.ts](../src/core/translator.ts)**: Bidirectional translator between Slack `mrkdwn` and Teams CommonMark/HTML. Converts user mentions, channel mentions, broadcast mentions (`@here`, `@channel`), links, and formats Adaptive Cards.
- **[deduplication.ts](../src/core/deduplication.ts)**: LRU cache of relayed message IDs to filter echoes and known bot senders, preventing infinite relay loops.
- **[thread-mapper.ts](../src/core/thread-mapper.ts)**: Bi-directional parent thread resolution linking Slack timestamps (`1711200000.123456`) and Teams message IDs.
- **[bridge.ts](../src/core/bridge.ts)**: Central orchestrator handling routing, loop filtering, translation, thread mapping, and adapter dispatch.

### B. Platform Adapters (`src/adapters/`)
- **[slack/client.ts](../src/adapters/slack/client.ts)**: Uses `@slack/bolt` and Slack Web API. Supports **Socket Mode** (zero inbound ports required) and native user impersonation (`chat:write.customize`) so Teams messages appear with the sender's real name and avatar.
- **[teams/client.ts](../src/adapters/teams/client.ts)**: Uses Microsoft Bot Framework SDK v4 (`botbuilder`) with **Resource-Specific Consent (RSC)** (`ChannelMessage.Read.Group`). Team Owners can install the app without needing tenant-wide Global Admin approval.
- **[matrix/types.ts](../src/adapters/matrix/types.ts)**: Matrix event converters for seamless future federation with Matrix homeservers (Synapse, Conduit, Dendrite).

### C. Persistence & Web Server (`src/db/` & `src/web/`)
- **[db/index.ts](../src/db/index.ts)**: Embedded SQLite database with WAL mode for channel configurations, message ID pairs, and user identity caching.
- **[web/server.ts](../src/web/server.ts)**: Express server hosting the Teams Bot Framework activity endpoint (`/api/messages`), REST API, and static dashboard assets on port `3978`.
- **[public/](../public/)**: Sleek dark-mode Admin Dashboard featuring active bridge metrics, live activity feed, connection health status, and 1-click manifest downloads.

### D. Packaging & Deployment
- **[manifests/slack/manifest.json](../manifests/slack/manifest.json)**: Ready-to-paste Slack App manifest.
- **[manifests/teams/manifest.json](../manifests/teams/manifest.json)** & `public/teams-app.zip`: Packaged Teams custom app with RSC permissions and icons.
- **[Dockerfile](../Dockerfile)** & **[docker-compose.yml](../docker-compose.yml)**: Multi-stage Docker build for self-hosting.
- **[docs/implementation_plan.md](implementation_plan.md)** & **[docs/setup_guide.md](setup_guide.md)**: Full setup guide and architecture reference.

---

## 2. Verification Results

### A. Automated Unit & Integration Tests
Ran `npm test` across all 4 test suites:
```
✓ tests/translator.test.ts (12 tests)
✓ tests/deduplication.test.ts (3 tests)
✓ tests/thread-mapper.test.ts (2 tests)
✓ tests/bridge.test.ts (3 tests)

Test Files  4 passed (4)
Tests       20 passed (20)
Duration    178ms
```

### B. TypeScript Compilation
Ran `npm run build`:
```
> slack-teams-interop@1.0.0 build
> tsc
(Clean build with zero errors, emitted to dist/)
```

### C. Live Server & Endpoint Verification
Launched service and tested via HTTP:
- `GET /api/health`: Returned status `ok` and platform configuration states.
- `POST /api/mappings`: Successfully created channel mapping `map-demo-1`.
- `GET /api/mappings`: Verified persistent retrieval from SQLite.
- `GET /api/manifests/slack`: Verified 1-click manifest generation.
- `GET /api/manifests/teams`: Verified custom app zip delivery.
- `GET /`: Verified modern web Admin Dashboard delivery.
