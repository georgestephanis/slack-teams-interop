# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

InterBridge is a self-hosted, two-way bridge between Slack channels and Microsoft Teams channels. It is a single Node.js service with four parts:

- A Slack adapter (Bolt, Socket Mode by default, or the HTTP Events API).
- A Teams adapter (Bot Framework SDK v4, Resource-Specific Consent).
- A SQLite store (versioned migrations) for channel mappings, message pairs (including stored message text), reactions, Teams service URLs, and a user profile cache.
- An Express server that hosts the Teams webhook, the Slack Events endpoint (HTTP mode), a signed Slack image proxy, a small admin REST API, and a static dashboard.

Human-facing docs: `README.md`, `SECURITY.md` (permissions, stored data, network surface), and `docs/setup_guide.md` (including the full environment variable table). `docs/implementation_plan.md` and `docs/walkthrough.md` are historical. **When a change affects setup, permissions, stored data, or public endpoints, update those docs in the same PR.**

## Commands

```bash
npm install
npm run dev            # tsx watch src/index.ts
npm run build          # tsc -> dist/
npm test               # vitest run
npx tsc --noEmit       # typecheck only
npm run package:teams  # rebuild public/teams-app.zip from manifests/teams/
docker compose up -d   # containerized run, persists to ./data
```

Requires Node.js 22+ (`better-sqlite3` and the `@azure/*` packages need it; `.npmrc` sets `engine-strict`).

Before proposing a change, run `npx tsc --noEmit` and `npm test`. Both are fast.

With no `SLACK_BOT_TOKEN` or `TEAMS_APP_ID` set, the service boots in API-only mode. That is enough to exercise the dashboard, the REST API, and the DB. Copy `.env.example` to `.env` for local config. Never commit `.env` or anything under `data/`.

## Layout

| Path | Role |
| --- | --- |
| `src/index.ts` | Bootstrap: builds `BridgeCore`, starts the adapters that are configured, starts the HTTP server, handles shutdown. |
| `src/config.ts` | Env schema (zod). Add new settings here **and** to `.env.example`. |
| `src/core/bridge.ts` | `BridgeCore` and the `BridgeAdapter` interface. All routing decisions: bot/echo filtering, mapping lookup, thread parent resolution, recording message ID pairs. |
| `src/core/types.ts` | Platform-neutral `NormalizedMessage`, `NormalizedReaction`, `ChannelMapping`. |
| `src/core/translator.ts` | Slack mrkdwn ⇄ Teams Markdown/HTML, plus Teams message formatting (plain header or Adaptive Card). |
| `src/core/media.ts` | `MediaSigner` (HMAC-signed `/media/slack/<token>` URLs) and the shared `MAX_TRANSFER_BYTES` limit. |
| `src/core/deduplication.ts` | Loop prevention: known bot IDs plus an LRU echo cache. |
| `src/core/thread-mapper.ts` | Thin wrapper over DB lookups that map Slack `ts` ⇄ Teams message IDs. |
| `src/db/index.ts` | `better-sqlite3` wrapper; runs migrations on open. |
| `src/db/migrations.ts` | Ordered schema migrations (`PRAGMA user_version`). |
| `src/adapters/slack/client.ts` | Slack events → `NormalizedMessage`/`NormalizedReaction`; posts with `chat:write.customize` so the sender's name and avatar show. |
| `src/adapters/teams/client.ts` | `TeamsActivityHandler` subclass; posts proactively via `continueConversationAsync`. |
| `src/adapters/matrix/types.ts` | Matrix event converters only. **Not wired into the running service.** |
| `src/web/server.ts` | Express app. Public: `/api/messages` (Teams webhook), `/slack/events` (HTTP mode), `/media/slack/:token`, `/api/health/live`. Behind admin auth: the `/api/*` routes, manifest generators, and the static `public/` dashboard. |
| `public/` | Vanilla JS/CSS dashboard (no build step) plus the prebuilt `teams-app.zip`. |
| `manifests/` | Source Slack and Teams app manifests. |
| `tests/` | Vitest specs. `bridge.test.ts` is an end-to-end routing test with mock adapters. |

## Message flow

1. An adapter receives a platform event and normalizes it: `sourcePlatform`, `sourceChannelId`, `sourceMessageId`, and optionally `sourceParentId`.
2. `BridgeCore.handleIncomingMessage` then:
   1. Drops messages from known bot IDs, then echoes of messages the bridge posted.
   2. Finds the enabled mapping for the source channel.
   3. Decides how attachments travel (`prepareAttachments`: images transfer, other files become `📎` lines) and collects any problems to tell the sender about.
   4. Resolves the thread parent on the other platform, if `syncThreads` is on.
   5. Calls `targetAdapter.sendMessage(...)`.
   6. Marks the result for echo suppression and stores the pair in `message_mappings`: IDs, origin platform, Teams thread root, content, sender, and attachment metadata.
   7. Sends a sender notice if anything didn't make it across.
3. Edits (`handleIncomingEdit`), deletes (`handleIncomingDelete`) and reactions (`handleIncomingReaction`) look up the stored pair and act on the mirrored copy. Nothing happens for messages without a pair (for example, messages older than `MESSAGE_RETENTION_DAYS`).
4. Failures inside `BridgeCore` are reported by emitting `'error'`, never thrown to the adapter.

Routing is hardcoded as a Slack⇄Teams pair in `bridge.ts`. A third platform needs changes there, not just a new adapter.

## Invariants and gotchas

- **Loop prevention is load-bearing.** Every path that posts to a platform must keep both the bot-sender check and the echo check intact. If you add a new outbound path (edits, files, reactions), make sure the bridge ignores its own resulting events. Otherwise two bridged channels will ping-pong.
- **`BridgeCore` is an `EventEmitter` that emits `'error'`.** An `'error'` event with no listener throws in Node.js. Always ensure an error listener is registered on `bridge` (such as in `src/index.ts`) and in any test or script that exercises failure paths.
- **ESM with `NodeNext` resolution.** Relative imports in `.ts` files must use the `.js` extension (`import { x } from './types.js'`).
- **Toolchain versions are new.** TypeScript 7, Vitest 5, Express 5, and Zod 4. Check current APIs rather than relying on older patterns (for example, Express 5 path syntax and Zod 4 `.default()` semantics).
- **Files: images transfer, everything else is a link.** `BridgeCore.prepareAttachments` (only when `syncFiles` is on) keeps images the target can show inline in `attachments`, and folds the rest into the content as `📎` lines in the *source* dialect. Teams → Slack: images with `fetchContent` are uploaded privately and shown as `slack_file` image blocks (keeping the sender override); the resulting `slackFileId` is stored in `message_mappings.source_attachments` and reused on edits. Slack → Teams: images get a signed `displayUrl` (`src/core/media.ts`, served at `/media/slack/<token>` before admin auth) only when `MEDIA_PROXY_SECRET` and `PUBLIC_URL` are set.
- **Sender notices for unsupported content.** `BridgeCore.senderIssues` collects problems for a *new* message (files with `syncFiles` off, `📎`-linked files, `NormalizedMessage.unsupported`, and the adapter's `SendResult.undelivered`). `notifySender` delivers them through `BridgeAdapter.notifySender`: Slack `chat.postEphemeral`, or a Teams thread reply via `postNotice`, which must go through `dedup.markRelayed`. Notices are skipped for bots, edits, and anything sent to the same person for the same reason within `SENDER_NOTICE_COOLDOWN_MS` (in memory, so it resets on restart). The in-message `📎` disclaimer comes from `MessageTranslator.fileDisclaimer` and is always on.
- **Never send platform credentials to message-supplied URLs.** The Teams bot token is only used for `isTeamsAttachmentHost` URLs, and the media proxy only fetches signed `https://files.slack.com` URLs. Keep both allowlists if you touch downloads.
- **Edits and deletes only flow from the origin side.** `message_mappings.origin_platform` records where a message was written. Edits are relayed only from the origin (or, for legacy rows with no origin, from any non-bot sender). Deletes are relayed only when the origin is known, so removing the bridge's mirror copy never deletes the author's original. The bridge's own `chat.update`/`updateActivity` calls come back as bot-authored edit events and must stay filtered.
- **Reactions are asymmetric.** Teams → Slack uses native reactions, reference-counted in the `reactions` table because the bridge reacts as one bot user. Slack → Teams can't react (no Bot Framework API), so it re-renders bridge-posted Teams messages with a footer from the stored `source_content`/`source_sender`. For Teams-authored messages, it keeps one notice per message (`teams_notice_message_id`, opt-in via `reactionNotices`). Work on a message pair runs under `BridgeCore.withPairLock`; re-read the pair inside the lock.
- **Teams per-message operations address the thread.** `updateActivity`/`deleteActivity` use the conversation id `<channelId>;messageid=<rootId>` (the message's own id for roots). The root is stored in `message_mappings.teams_root_message_id`.
- **Schema changes go through migrations.** `src/db/migrations.ts` is an append-only list tracked with `PRAGMA user_version`. Add a new migration; never edit or reorder a shipped one. The DB refuses to open if its version is newer than the code, and it writes `<db>.bak-v<N>` before upgrading an existing database. New `ChannelMapping.options` keys also need a default in `DEFAULT_MAPPING_OPTIONS` (`src/core/types.ts`), because stored mappings won't have them.
- **Teams `serviceUrl` is persisted** in `teams_conversations`, recorded from every inbound activity (`onTurn`). Lookup order is: exact channel, then same team, then most recently seen, then `TEAMS_SERVICE_URL`. When debugging region-specific (EMEA/APAC) failures, check that table first.
- **Teams auth type must match the Azure registration.** `TEAMS_APP_TYPE` (`SingleTenant` for bots created since July 2025, `MultiTenant` for older ones) is passed to `ConfigurationBotFrameworkAuthentication`, and to `MicrosoftAppCredentials` as the tenant for attachment downloads. Keep both in sync if you add another place that gets a token.
- **Teams addresses the bot as `28:<appId>`**, not just the bare app ID. Account for both forms when comparing sender IDs or registering bot IDs.
- **`/api/messages` is authenticated by the Bot Framework adapter** (it validates Azure-issued JWTs). It must stay reachable without admin credentials, as must `/slack/events` (verified by Slack's signing secret). All other management endpoints (`/api/mappings`, etc.) and the dashboard require admin auth. When modifying routing, ensure `/api/messages` and liveness probes stay exempt from basic auth.
- **Dashboard HTML is built with template strings.** Pass every server-supplied value through `escapeHtml()` in `public/app.js`, including values in attributes.
- **Tests write real SQLite files** under `./data/`. Use a unique filename per spec file so parallel runs don't collide, and delete the file *and its `-wal`/`-shm`/`.bak-v*` siblings* before and after (see `removeDb` in the newer tests). A DB left behind by a branch with a newer schema trips the migration "newer than this build" guard.
- **`public/teams-app.zip` is committed and served** by `/api/manifests/teams`. Run `npm run package:teams` after editing `manifests/teams/`. The manifest's `botId` is a placeholder the operator must replace, so the committed zip (and the dashboard download) won't install as-is.
- **Slack HTTP (Events API) mode** mounts Bolt's `ExpressReceiver` router (`SlackAdapter.httpRouter`) on the shared server at `/slack/events`, **before** `express.json()` (signature verification needs the raw body) and before admin auth. In that mode `app.start()` is skipped, because it would open Bolt's own listener on port 3000.

## Conventions

- Match the existing style: 2-space indent, single quotes, semicolons. Use `/** ... */` headers on modules and public methods, and short numbered step comments inside longer handlers.
- Keep platform-specific logic in `src/adapters/<platform>/`. `src/core/` should stay platform-neutral, apart from the Slack/Teams routing in `bridge.ts`.
- New translator behavior gets a case in `tests/translator.test.ts`. New routing behavior gets a case in `tests/bridge.test.ts`, using the mock adapters there.
- Branch from `trunk` (the default branch) and keep one logical change per PR.

## License

The project is **AGPL-3.0-or-later** (`LICENSE`, `package.json`). New dependencies must be compatible with GPLv3: permissive licenses (MIT, BSD, ISC, Apache-2.0, and so on) are fine; GPLv2-only, SSPL and proprietary licenses aren't. Check before adding one. Keep the dashboard footer's source link.

## Safety

- Don't send test messages to real Slack workspaces or Teams tenants, or post to a live bridge, without explicit approval from the human. Use the mock adapters in `tests/bridge.test.ts` instead.
- Never commit tokens, app passwords, `.env`, or `data/*.sqlite*`.
