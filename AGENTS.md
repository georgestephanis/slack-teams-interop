# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

InterBridge is a self-hosted, two-way bridge between Slack channels and Microsoft Teams channels. It is a single Node.js service with four parts:

- A Slack adapter (Bolt, Socket Mode).
- A Teams adapter (Bot Framework SDK v4, Resource-Specific Consent).
- A SQLite store for channel mappings, message ID pairs, and a user profile cache.
- An Express server that hosts the Teams webhook, a small admin REST API, and a static dashboard.

Human-facing docs live in `README.md` and `docs/`. `docs/implementation_plan.md` records the original design reasoning.

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
| `src/core/deduplication.ts` | Loop prevention: known bot IDs plus an LRU echo cache. |
| `src/core/thread-mapper.ts` | Thin wrapper over DB lookups that map Slack `ts` ⇄ Teams message IDs. |
| `src/db/index.ts` | `better-sqlite3` wrapper. Schema is created with `CREATE TABLE IF NOT EXISTS` in `initTables()`. |
| `src/adapters/slack/client.ts` | Slack events → `NormalizedMessage`/`NormalizedReaction`; posts with `chat:write.customize` so the sender's name and avatar show. |
| `src/adapters/teams/client.ts` | `TeamsActivityHandler` subclass; posts proactively via `continueConversationAsync`. |
| `src/adapters/matrix/types.ts` | Matrix event converters only. **Not wired into the running service.** |
| `src/web/server.ts` | Express app: `/api/messages` (Teams webhook), `/api/*` admin routes, manifest generators, static `public/`. |
| `public/` | Vanilla JS/CSS dashboard (no build step) plus the prebuilt `teams-app.zip`. |
| `manifests/` | Source Slack and Teams app manifests. |
| `tests/` | Vitest specs. `bridge.test.ts` is an end-to-end routing test with mock adapters. |

## Message flow

1. An adapter receives a platform event and normalizes it: `sourcePlatform`, `sourceChannelId`, `sourceMessageId`, and optionally `sourceParentId`.
2. `BridgeCore.handleIncomingMessage` then:
   1. Drops messages from known bot IDs, then echoes of messages the bridge posted.
   2. Finds the enabled mapping for the source channel.
   3. Resolves the thread parent on the other platform, if `syncThreads` is on.
   4. Calls `targetAdapter.sendMessage(...)`.
   5. Marks the result for echo suppression and stores the Slack⇄Teams ID pair in `message_mappings`.
3. Reactions follow the same pattern via `handleIncomingReaction`. They only mirror onto messages that have a stored ID pair.
4. Failures inside `BridgeCore` are reported by emitting `'error'`, never thrown to the adapter.

Routing is hardcoded as a Slack⇄Teams pair in `bridge.ts`. A third platform needs changes there, not just a new adapter.

## Invariants and gotchas

- **Loop prevention is load-bearing.** Every path that posts to a platform must keep both the bot-sender check and the echo check intact. If you add a new outbound path (edits, files, reactions), make sure the bridge ignores its own resulting events. Otherwise two bridged channels will ping-pong.
- **`BridgeCore` is an `EventEmitter` that emits `'error'`.** An `'error'` event with no listener throws. Keep a listener registered in `src/index.ts`, and add one in any test or script that can hit an error path.
- **ESM with `NodeNext` resolution.** Relative imports in `.ts` files must use the `.js` extension (`import { x } from './types.js'`).
- **Toolchain versions are new.** TypeScript 7, Vitest 5, Express 5, and Zod 4. Check current APIs rather than relying on older patterns (for example, Express 5 path syntax and Zod 4 `.default()` semantics).
- **`options.syncEdits`, `syncDeletes`, and `syncFiles` are declared but not implemented.** The Slack adapter drops `message_changed` and `message_deleted`, and nothing transfers files. Don't assume these features work. If you implement one, update the README feature list to match.
- **No schema migrations.** Tables are created with `IF NOT EXISTS`, so altering a column in `initTables()` will **not** affect existing deployments. Any schema change needs an explicit migration step (e.g. `PRAGMA user_version`).
- **Teams `serviceUrl` is cached in memory only.** After a restart, outbound posts to a channel use `TEAMS_SERVICE_URL` until that channel sends an inbound activity. Keep this in mind when debugging region-specific (EMEA/APAC) failures.
- **Teams addresses the bot as `28:<appId>`**, not the bare app ID. Account for both forms when comparing sender IDs.
- **`/api/messages` is authenticated by the Bot Framework adapter** (it validates Azure-issued JWTs). It must stay reachable without admin credentials. Every other admin route should require them. Don't add unauthenticated routes that read or modify mappings.
- **Dashboard HTML is built with template strings.** Pass every server-supplied value through `escapeHtml()` in `public/app.js`, including values in attributes.
- **Tests write real SQLite files** under `./data/` and delete them in `afterEach`. Use a unique filename per spec file so parallel runs don't collide.
- **`public/teams-app.zip` is committed and served** by `/api/manifests/teams`. Run `npm run package:teams` after editing `manifests/teams/`. The manifest's `botId` is a placeholder the operator must replace.
- **Slack HTTP (Events API) mode is not fully wired.** Bolt's default receiver listens on its own port instead of the shared Express server. Socket Mode is the supported path.

## Conventions

- Match the existing style: 2-space indent, single quotes, semicolons. Use `/** ... */` headers on modules and public methods, and short numbered step comments inside longer handlers.
- Keep platform-specific logic in `src/adapters/<platform>/`. `src/core/` should stay platform-neutral, apart from the Slack/Teams routing in `bridge.ts`.
- New translator behavior gets a case in `tests/translator.test.ts`. New routing behavior gets a case in `tests/bridge.test.ts`, using the mock adapters there.
- Branch from `trunk` (the default branch) and keep one logical change per PR.

## Safety

- Don't send test messages to real Slack workspaces or Teams tenants, or post to a live bridge, without explicit approval from the human. Use the mock adapters in `tests/bridge.test.ts` instead.
- Never commit tokens, app passwords, `.env`, or `data/*.sqlite*`.
