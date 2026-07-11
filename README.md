# OfficeChat

## Release Candidate Stabilization

OfficeChat v0.1 RC adds production-oriented Docker targets, `/ready` readiness checks, stricter production configuration validation, security headers, backup/restore scripts, Playwright E2E smoke infrastructure, and release documentation.

Key docs:

- [docs/PRODUCTION_RU.md](docs/PRODUCTION_RU.md)
- [docs/BACKUP_RESTORE_RU.md](docs/BACKUP_RESTORE_RU.md)
- [docs/E2E_TESTS_RU.md](docs/E2E_TESTS_RU.md)
- [docs/RELEASE_CHECKLIST_RU.md](docs/RELEASE_CHECKLIST_RU.md)

Production migrations are explicit:

```bash
docker compose -f docker-compose.prod.yml run --rm backend alembic upgrade head
docker compose -f docker-compose.prod.yml up -d
```

Health endpoints:

- Backend liveness: `GET /health`
- Backend readiness: `GET /ready`
- Frontend liveness: `GET /api/health`

## Session hardening

Protected frontend routes centrally handle expired or invalid JWTs: only `officechat.access_token` is removed, UI preferences remain intact, active WebSockets stop, and the browser returns to the localized login page. HTTP 401 ends the local session; HTTP 403 reports denied access without logging the user out.

WebSocket access logs redact `token`, `access_token`, `authorization`, and `ticket` query values. `APP_SECRET_KEY` (also accepted as `JWT_SECRET`) must be long and persistent in production. Changing it invalidates every active session. JWT storage remains in `localStorage` for the development architecture; secure cookie/session migration remains planned.

## Audit log

Administrators can review and export sanitized security and administrative events at `http://localhost:3100/ru/admin/audit`. The log records authentication, user/group/bot management, profile changes, discussions and retention operations without passwords, tokens, message bodies, attachment contents or filesystem paths. See [docs/AUDIT_LOG_RU.md](docs/AUDIT_LOG_RU.md).

## Granular Permissions

OfficeChat has a granular permission foundation in addition to roles. Initial sensitive permissions are `can_broadcast` and `can_pin_messages`; they are not automatically granted to `admin`, `moderator`, group owners, or ordinary users. `superadmin` has all active permissions implicitly and is the only role that can assign or revoke explicit grants in `/ru/admin/users`. Permission changes are audited as `permission.granted` / `permission.revoked` and sent to the affected open session through `/api/ws/me` as `permissions.updated`. See [docs/PERMISSIONS_RU.md](docs/PERMISSIONS_RU.md).

Pinned Messages v0.1 lets trusted human users with `can_pin_messages` pin, unpin, and annotate important messages in group, direct, and discussion chats. Admin role alone does not grant this action, and direct/discussion privacy is still enforced. Pinned-message actions are audited and synchronized through the selected chat WebSocket channel. See [docs/PINNED_MESSAGES_RU.md](docs/PINNED_MESSAGES_RU.md).

Broadcast Announcements v0.1 adds a separate corporate announcement inbox and sender flow for trusted users with effective `can_broadcast`. Broadcasts are stored as one announcement plus recipient rows, use preview/confirmation tokens and Valkey rate limiting before send, and deliver `announcement.created/read/retracted` through `/api/ws/me`. Announcement unread counters are separate from chat unread counters. See [docs/BROADCASTS_RU.md](docs/BROADCASTS_RU.md).

OfficeChat is an open-source, self-hosted corporate chat for local networks and private environments. The project is designed to work well in LAN/offline deployments first, while keeping the architecture ready for secure internet-facing deployments later.

Current status: early development. This repository currently contains the Dockerized scaffold, local authentication, admin user management, groups, direct messages, discussions, WebSocket real-time updates, and secure local attachments for group, direct, and discussion messages. LDAP/AD, S3/object storage, antivirus scanning, and production nginx configuration are not implemented yet.

Retention and Storage Management v0.1 adds disabled-by-default message archiving, attachment retention, mandatory dry-run/manual cleanup, storage statistics, audit records, and participant-only read-only archives. Admin UI: `http://localhost:3100/ru/admin/storage`. Cleanup never runs during migration or startup. See [docs/RETENTION_RU.md](docs/RETENTION_RU.md) and [docs/STORAGE_MANAGEMENT_RU.md](docs/STORAGE_MANAGEMENT_RU.md).

## Tech Stack

- Backend: FastAPI and Python
- Frontend: Next.js, React, and TypeScript
- Database: PostgreSQL
- Cache, presence, and future queue foundation: Valkey
- Deployment: Docker Compose
- Future reverse proxy: nginx

## Required Tools

- Git
- Docker Desktop with Docker Compose

## Local Development Quick Start

```powershell
copy .env.example .env
docker compose up -d --build
```

## Local URLs

- Frontend: http://localhost:3100
- Backend API: http://localhost:8100
- Backend root: http://localhost:8100/
- Backend docs: http://localhost:8100/docs
- User app: http://localhost:3100/ru/app
- Groups page: http://localhost:3100/ru/groups

## Authentication

Local authentication foundation is available in early form. Self-registration is disabled; users are created by an administrator.

Development bootstrap account:

- Username: `admin`
- Password: `admin12345`

Admin users page:

- http://localhost:3100/ru/admin/users
- Only `superadmin` and `admin` users can access it.
- Admins can create users, edit display name/email/role/active state, and reset local user passwords.
- Only `superadmin` can edit or promote `superadmin` users.
- Cleanup actions are soft by default: users are disabled with `is_active=false`, not physically deleted. This keeps message authorship and future audit history intact.

User-facing app shell is available at http://localhost:3100/ru/app. It uses a viewport-filling messenger layout with a resizable/collapsible chat sidebar, a scrollable active chat, and an optional discussion panel. The sidebar provides All chats, Groups, and Direct tabs; its width, collapsed state, selected tab, and appearance preferences are stored in browser `localStorage`.

Sidebar activity indicators are available in early frontend form. Groups and direct users can show local unread dots, last message previews, short activity timestamps, and recent-activity ordering. A local sidebar search filters groups by name or slug and users by display name or username. The normal direct-message list hides inactive users, the current user, and bot users. Activity state is stored in browser `localStorage` for now. Backend read receipts, server-side unread counters, and cross-device unread synchronization are planned later.

Browser notifications are available in early frontend form. Users can enable them in the app shell settings; they work only while OfficeChat is open in a browser tab/window and only after the browser and OS grant notification permission. The settings panel includes diagnostics, a test notification button, and a setup guide. See [docs/NOTIFICATIONS_RU.md](docs/NOTIFICATIONS_RU.md). Server push notifications, service workers, email notifications, and mobile push are planned later.

Reliable in-app notification delivery uses a personal WebSocket channel:

- `WS /api/ws/me?token=...`
- It receives `user.group.message.created` and `user.direct.message.created` events relevant to the authenticated user.
- Browser notifications in `/ru/app` use this personal channel, while group/direct chat panels keep their existing channel-specific WebSocket updates.
- Current WebSocket delivery is single-instance only; multi-instance production should use Valkey pub/sub or another broker later.

Presence, persistent last seen, and typing indicators are available in v0.1. `/api/ws/me` maintains one Valkey-backed presence connection per browser tab/device with heartbeat and offline grace handling; `GET /api/presence` returns a bounded privacy-filtered snapshot. Group, direct, and discussion room sockets carry throttled typing events without storing draft text. PostgreSQL is updated only when a user actually transitions offline. See [docs/PRESENCE_RU.md](docs/PRESENCE_RU.md).

Unread counters and direct-message read receipts use one PostgreSQL high-water row per user/chat. Existing history is backfilled as read by migration `20260704_0017`; selected visible chats mark through their newest loaded message after a short debounce, while hidden tabs retain unread state. `/api/ws/me` synchronizes `unread.updated` across tabs/devices, and direct room sockets deliver participant-only `direct.read`. See [docs/UNREAD_RU.md](docs/UNREAD_RU.md).

Message Search v0.1 uses PostgreSQL `simple` full-text GIN indexes for mixed RU/EN message bodies and attachment filenames. The user app provides global/current-chat search, sender/date/attachment filters, cursor pagination, keyboard access, context loading, temporary target highlighting, and authorized deep links. Deleted and archived content is excluded; admin roles do not bypass private direct/discussion membership. Raw `q` values are redacted from access logs. See [docs/MESSAGE_SEARCH_RU.md](docs/MESSAGE_SEARCH_RU.md).

Pinned messages appear as a compact strip in group, direct, and discussion chats in `/ru/app`. Each message payload includes `is_pinned`, `pin_id`, and `pinned_at`, and the pinned strip can jump to the original message through the existing message-context loader. Deleted or archived messages are automatically removed from pins.

Current development uses one frontend on port `3100`. User routes live under `/ru/app`, while admin routes remain under `/ru/admin/*`. Future production deployment can split user/admin surfaces with nginx hostnames or separate frontend entrypoints.

User app settings are stored in browser `localStorage` for now. Future versions should persist language, sidebar side, font size, accent color, and profile preferences in backend user preferences.

The user app includes a profile panel. Authenticated active users can review account details, update their own display name through `PATCH /api/auth/me`, and upload, replace, or remove a local PNG/JPEG/WebP avatar up to 5 MB. Avatars are stored under the backend uploads volume and displayed with initials fallback across the messenger UI. See [docs/PROFILE_RU.md](docs/PROFILE_RU.md). Backend-persisted UI preferences remain planned.

The user sidebar uses `GET /api/users`, an authenticated endpoint that returns active users with public directory fields only.

Direct/private messages are available in the user app shell:

- `GET /api/direct/conversations`
- `POST /api/direct/conversations`
- `GET /api/direct/conversations/{conversation_id}/messages`
- `POST /api/direct/conversations/{conversation_id}/messages`
- `PATCH /api/direct/conversations/{conversation_id}/messages/{message_id}`
- `DELETE /api/direct/conversations/{conversation_id}/messages/{message_id}`
- `WS /api/ws/direct/{conversation_id}?token=...`

Direct messages are participant-only in the MVP: `superadmin` and `admin` users have no special ability to read private conversations where they are not participants. Bot users are excluded from direct messages in this version. Direct messages support protected local attachments and ephemeral typing indicators; read receipts are not implemented yet.

Reply-to-message support is available for both group chats and direct messages. Users can reply to an existing message, see a compact quoted preview in the new message, and still edit/delete messages through the existing actions. This is a lightweight reply feature only; threaded discussions, nested reply views, forwarding, and markdown rendering are planned later.

Basic `@username` mentions are available in group messages. OfficeChat detects active non-bot users who belong to the same group, includes mention metadata in REST/WebSocket payloads, highlights recognized mentions in the chat UI, and uses mention-aware browser notification text. Unknown usernames are ignored safely. Autocomplete, profile links, direct-message mentions, and markdown rendering are not implemented yet.

Message discussions are available from group messages in the user app shell. Use the `Discuss` / `Обсудить` action to open a right-side panel with the source-message preview, participants, messages, local attachments, Enter sending, Shift+Enter line breaks, typing indicators, and WebSocket updates. Discussion owners, source-group owners, `admin`, and `superadmin` users can invite active source-group members by username. Direct-message discussions, nested threads, a discussion sidebar, and read receipts are not implemented yet. See [docs/DISCUSSIONS_RU.md](docs/DISCUSSIONS_RU.md).

Groups foundation is available. Admins can create groups, group owners can manage members, and regular users can see groups where they are members.

Groups can be archived and restored with `is_active=false/true`. Archived groups are not physically deleted, which keeps message history, attachments, and membership references safe. Regular user and app-shell group lists show active groups only; admin group management can request archived groups with `GET /api/groups?include_inactive=true`.

Messages foundation is available on group detail pages. REST API remains the source of truth:

- `GET /api/groups/{group_id}/messages`
- `POST /api/groups/{group_id}/messages`
- `PATCH /api/groups/{group_id}/messages/{message_id}`
- `DELETE /api/groups/{group_id}/messages/{message_id}`

Members can read and send messages in their groups. Message authors can edit and delete their own messages. Group owners, group moderators, `admin`, and `superadmin` users can delete messages according to the current permission model.

The group chat UI includes live update status, readable wrapped multi-line messages, a BOT badge for bot-authored messages, compact message actions, and a bottom composer. `Enter` sends, `Shift+Enter` inserts a new line, and `Ctrl+Enter` remains compatible. Group attachments use a compact file picker control. The mobile layout is a basic one-panel-at-a-time experience in v0.1.

WebSocket real-time updates are available for group messages:

- `WS /api/ws/groups/{group_id}?token=...`
- Development clients pass the JWT token in the query string.
- Sending and reaction changes happen through REST; WebSocket receives message lifecycle events and compact `*.message.reactions.updated` updates.
- Current WebSocket manager is single-instance only. Multi-instance production should use Valkey pub/sub or another broker later.
- Typing indicators are available; read receipts are not implemented yet.

File attachments are available for group, direct, and discussion messages:

- `POST /api/groups/{group_id}/messages/with-attachment`
- `POST /api/groups/{group_id}/messages/with-attachments`
- `GET /api/groups/{group_id}/attachments/{attachment_id}/download`
- `POST /api/direct/conversations/{conversation_id}/messages/with-attachment`
- `POST /api/direct/conversations/{conversation_id}/messages/with-attachments`
- `GET /api/direct/conversations/{conversation_id}/attachments/{attachment_id}/download`
- `POST /api/discussions/{discussion_id}/messages/with-attachment`
- `POST /api/discussions/{discussion_id}/messages/with-attachments`
- `GET /api/discussions/{discussion_id}/attachments/{attachment_id}/download`
- Files are stored in the backend uploads Docker volume mounted at `/data/uploads`.
- Downloads require membership in the relevant group, direct conversation, or discussion; storage paths are never exposed.
- Upload defaults: `ATTACHMENT_MAX_UPLOAD_SIZE_MB=25`, `ATTACHMENT_MAX_FILES_PER_MESSAGE=10`, `ATTACHMENT_MAX_TOTAL_SIZE_MB=50`.
- Allowed extensions default to `txt,log,csv,md,json,xml,yaml,yml,ini,conf,pdf,doc,docx,xls,xlsx,png,jpg,jpeg,webp,zip`.
- Executable and script formats such as `exe,com,bat,cmd,ps1,msi,dll,scr,js,vbs,jar,sh,apk` remain blocked even if a browser reports a generic MIME type.
- Antivirus scanning, backend thumbnails, PDF/document previews, S3, and automatic retention workers are not implemented yet.
- The uploads volume must be included in backups together with PostgreSQL data.

In group, direct, and discussion composers, users can select or drag multiple files and append PNG, JPEG, or WebP screenshots with `Ctrl+V`. Up to 10 attachments and 50 MB combined are allowed per message by default; the per-file limit remains 25 MB. Selection never uploads automatically, individual files can be removed, and failed sends preserve the composer state.

Sent PNG, JPEG, and WebP attachments display as a compact responsive gallery. The protected lightbox supports previous/next navigation and keyboard arrows; non-image files remain compact authenticated download rows. Storage stays in the local Docker volume. Antivirus scanning, resumable uploads, backend thumbnails/compression, and S3/MinIO are not implemented.

The group, direct, and discussion message composers include a lightweight Unicode emoji picker with RU/EN search and a local frequently-used list. Recent emoji are stored in the browser under `officechat.emoji.recent`. Message reactions support `👍 ❤️ 😂 ✅ 🔥 👀 🎉 😮 😢 👎`, one reaction per user/emoji/message, repeated-click removal, and real-time channel synchronization. Custom reactions, stickers, GIFs, and reaction notifications are not implemented. Local avatar upload and avatar display in messenger messages and user lists are also available in v0.1, while optional avatar cropping/editing remains planned.

Bot foundation is available for incoming webhooks:

- Admin page: http://localhost:3100/ru/admin/bots
- `GET /api/admin/bots`
- `POST /api/admin/bots`
- `PATCH /api/admin/bots/{bot_id}`
- `POST /api/admin/bots/{bot_id}/rotate-token`
- `POST /api/bots/incoming/{token}`

Each bot has a linked user with role `bot`. Add that bot user to a group by username, then external systems can post messages into the group with the bot token. Full bot tokens are shown only once on create/rotate; only hashes are stored. Outgoing webhooks, AI providers, bot file uploads, direct messages, and per-bot scoped permissions beyond group membership are not implemented yet.

Incoming bot webhooks accept simple payloads with `group_id` or `group_slug` and `body`, plus monitoring-friendly fields for systems such as Zabbix: `title`, `severity`, `status`, `host`, `ip`, `problem`, `trigger`, `event_id`, `url`, and `timestamp`. These fields are formatted as plain text and broadcast through the existing `message.created` WebSocket event.

```powershell
curl.exe -X POST http://localhost:8100/api/bots/incoming/PASTE_TOKEN_HERE -H "Content-Type: application/json" -d "{\"group_slug\":\"alerts\",\"severity\":\"high\",\"status\":\"problem\",\"title\":\"Disk space low\",\"host\":\"DC5\",\"ip\":\"192.168.1.100\",\"problem\":\"Free space on C: is less than 10%\",\"event_id\":\"12345\",\"url\":\"http://zabbix.local/tr_events.php?triggerid=12345\",\"body\":\"Check the server before the next backup window.\"}"
```

Important auth environment variables:

- `APP_SECRET_KEY` - development placeholder is included in `.env.example`; change it for any shared or production deployment.
- `ACCESS_TOKEN_EXPIRE_MINUTES` - local bearer token lifetime.
- `BOOTSTRAP_SUPERADMIN_USERNAME`
- `BOOTSTRAP_SUPERADMIN_PASSWORD`
- `BOOTSTRAP_SUPERADMIN_DISPLAY_NAME`
- `MESSAGE_MAX_LENGTH` - maximum text message length, default `4000`.
- `ATTACHMENT_MAX_UPLOAD_SIZE_MB` - per-file maximum in MB, default `25` (`MAX_UPLOAD_SIZE_MB` remains a compatibility alias).
- `ATTACHMENT_MAX_FILES_PER_MESSAGE` - maximum files per message, default `10`.
- `ATTACHMENT_MAX_TOTAL_SIZE_MB` - combined attachment size per message, default `50`.
- `ALLOWED_UPLOAD_EXTENSIONS` - comma-separated allowlist for upload extensions.
- `UPLOADS_DIR` - backend storage path for local uploads, default `/data/uploads`.
- `PRESENCE_CONNECTION_TTL_SECONDS` - Valkey connection TTL, default `90`.
- `PRESENCE_HEARTBEAT_SECONDS` - personal socket heartbeat interval, default `25`.
- `PRESENCE_OFFLINE_GRACE_SECONDS` - reconnect grace before offline, default `15`.
- `TYPING_TTL_SECONDS` - stale typing state TTL, default `5`.
- `PINNED_MESSAGES_MAX_PER_CHAT` - maximum pinned messages per chat, default `20`.
- `BROADCAST_TITLE_MAX_LENGTH` - maximum announcement title length, default `160`.
- `BROADCAST_BODY_MAX_LENGTH` - maximum announcement body length, default `10000`.
- `BROADCAST_MAX_RECIPIENTS` - maximum resolved recipients per broadcast, default `10000`.
- `BROADCAST_MAX_PER_HOUR` - per-sender broadcast rate limit, default `10`.
- `BROADCAST_PREVIEW_TTL_SECONDS` - preview confirmation lifetime, default `300`.
- `BROADCAST_RETENTION_DAYS` - planned broadcast retention window, default `365`.

## Useful Docker Compose Commands

```powershell
docker compose up -d --build
docker compose ps
docker compose logs -f backend
docker compose logs -f frontend
docker compose down
```

## Frontend Tests

Frontend unit and component tests use Vitest, jsdom, and React Testing Library. They live in `apps/frontend/tests` and run without a browser window or real network requests.

```powershell
docker compose exec frontend npm run test:run
docker compose exec frontend npm run test:watch
```

The test environment supplies resettable browser API mocks for storage, visibility, WebSocket, fetch, media queries, and resize observation. Manual browser smoke checks remain separate; Playwright end-to-end coverage is planned for a later milestone.

## Verification

```powershell
docker compose exec backend python -m pytest -q
docker compose exec frontend npm run test:run
docker compose exec frontend npm run build
curl http://localhost:8100/
curl http://localhost:8100/health
curl http://localhost:8100/api/system/info
curl http://localhost:8100/api/db-check
curl http://localhost:8100/api/cache-check
curl.exe -X POST http://localhost:8100/api/auth/login -H "Content-Type: application/json" -d "{\"username\":\"admin\",\"password\":\"admin12345\"}"
```

## License

OfficeChat is licensed under the Apache License 2.0. See [LICENSE](LICENSE).

The core project should prefer permissive dependencies such as MIT, Apache-2.0, BSD, and PostgreSQL License. AGPL, SSPL, unclear source-available licenses, and unclear commercial licenses should be avoided in the core project.
