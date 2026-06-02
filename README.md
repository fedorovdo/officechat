# OfficeChat

OfficeChat is an open-source, self-hosted corporate chat for local networks and private environments. The project is designed to work well in LAN/offline deployments first, while keeping the architecture ready for secure internet-facing deployments later.

Current status: early development. This repository currently contains the Dockerized scaffold, local authentication, admin user management, groups, REST group messages, basic WebSocket real-time updates, local file attachments for group messages, and basic direct messages between users. LDAP/AD, S3/object storage, antivirus scanning, and production nginx configuration are not implemented yet.

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

User-facing app shell is available at http://localhost:3100/ru/app. It shows a top bar, group chat sidebar, active users sidebar section for direct messages, local UI settings, and reusable chat panels with messages, attachments for groups, WebSocket updates, and Ctrl+Enter sending.

Sidebar activity indicators are available in early frontend form. Groups and direct users can show local unread dots, last message previews, short activity timestamps, and recent-activity ordering. A local sidebar search filters groups by name or slug and users by display name or username. The normal direct-message list hides inactive users, the current user, and bot users. Activity state is stored in browser `localStorage` for now. Backend read receipts, server-side unread counters, and cross-device unread synchronization are planned later.

Browser notifications are available in early frontend form. Users can enable them in the app shell settings; they work only while OfficeChat is open in a browser tab/window and only after the browser and OS grant notification permission. The settings panel includes diagnostics, a test notification button, and a setup guide. See [docs/NOTIFICATIONS_RU.md](docs/NOTIFICATIONS_RU.md). Server push notifications, service workers, email notifications, and mobile push are planned later.

Reliable in-app notification delivery uses a personal WebSocket channel:

- `WS /api/ws/me?token=...`
- It receives `user.group.message.created` and `user.direct.message.created` events relevant to the authenticated user.
- Browser notifications in `/ru/app` use this personal channel, while group/direct chat panels keep their existing channel-specific WebSocket updates.
- Current WebSocket delivery is single-instance only; multi-instance production should use Valkey pub/sub or another broker later.

Current development uses one frontend on port `3100`. User routes live under `/ru/app`, while admin routes remain under `/ru/admin/*`. Future production deployment can split user/admin surfaces with nginx hostnames or separate frontend entrypoints.

User app settings are stored in browser `localStorage` for now. Future versions should persist language, sidebar side, font size, accent color, and profile preferences in backend user preferences.

The user sidebar uses `GET /api/users`, an authenticated endpoint that returns active users with public directory fields only.

Direct/private messages are available in the user app shell:

- `GET /api/direct/conversations`
- `POST /api/direct/conversations`
- `GET /api/direct/conversations/{conversation_id}/messages`
- `POST /api/direct/conversations/{conversation_id}/messages`
- `PATCH /api/direct/conversations/{conversation_id}/messages/{message_id}`
- `DELETE /api/direct/conversations/{conversation_id}/messages/{message_id}`
- `WS /api/ws/direct/{conversation_id}?token=...`

Direct messages are participant-only in the MVP: `superadmin` and `admin` users have no special ability to read private conversations where they are not participants. Bot users are excluded from direct messages in this version. Direct-message file attachments, read receipts, and typing indicators are not implemented yet.

Reply-to-message support is available for both group chats and direct messages. Users can reply to an existing message, see a compact quoted preview in the new message, and still edit/delete messages through the existing actions. This is a lightweight reply feature only; threaded discussions, nested reply views, forwarding, and markdown rendering are planned later.

Basic `@username` mentions are available in group messages. OfficeChat detects active non-bot users who belong to the same group, includes mention metadata in REST/WebSocket payloads, highlights recognized mentions in the chat UI, and uses mention-aware browser notification text. Unknown usernames are ignored safely. Autocomplete, profile links, direct-message mentions, and markdown rendering are not implemented yet.

Message discussions are available from group messages in the user app shell. Use the `Discuss` / `Обсудить` action to open a right-side panel with the source-message preview, participants, text-only discussion messages, Ctrl+Enter sending, and WebSocket updates. Discussion owners, source-group owners, `admin`, and `superadmin` users can invite active source-group members by username. Direct-message discussions, discussion attachments, nested threads, a discussion sidebar, read receipts, and typing indicators are not implemented yet. See [docs/DISCUSSIONS_RU.md](docs/DISCUSSIONS_RU.md).

Groups foundation is available. Admins can create groups, group owners can manage members, and regular users can see groups where they are members.

Groups can be archived and restored with `is_active=false/true`. Archived groups are not physically deleted, which keeps message history, attachments, and membership references safe. Regular user and app-shell group lists show active groups only; admin group management can request archived groups with `GET /api/groups?include_inactive=true`.

Messages foundation is available on group detail pages. REST API remains the source of truth:

- `GET /api/groups/{group_id}/messages`
- `POST /api/groups/{group_id}/messages`
- `PATCH /api/groups/{group_id}/messages/{message_id}`
- `DELETE /api/groups/{group_id}/messages/{message_id}`

Members can read and send messages in their groups. Message authors can edit and delete their own messages. Group owners, group moderators, `admin`, and `superadmin` users can delete messages according to the current permission model.

The group chat UI includes live update status, readable wrapped multi-line messages, a BOT badge for bot-authored messages, compact message actions, and Ctrl+Enter sending from the composer.

WebSocket real-time updates are available for group messages:

- `WS /api/ws/groups/{group_id}?token=...`
- Development clients pass the JWT token in the query string.
- Sending still happens through REST; WebSocket only receives `message.created`, `message.updated`, and `message.deleted` events.
- Current WebSocket manager is single-instance only. Multi-instance production should use Valkey pub/sub or another broker later.
- Typing indicators, read receipts, and reactions are not implemented yet.

File attachments are available for group messages:

- `POST /api/groups/{group_id}/messages/with-attachment`
- `GET /api/groups/{group_id}/attachments/{attachment_id}/download`
- Files are stored in the backend uploads Docker volume mounted at `/data/uploads`.
- Upload defaults: `MAX_UPLOAD_SIZE_MB=25`.
- Allowed extensions default to `pdf,doc,docx,xls,xlsx,png,jpg,jpeg,txt,zip`.
- Antivirus scanning, previews, thumbnails, drag-and-drop, S3, and retention cleanup are not implemented yet.

Planned UX features include standard emoji support in chat messages, user profile pages, avatar/profile photo upload, and avatar display in messages and user lists. These are roadmap items and are not implemented yet.

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
- `MAX_UPLOAD_SIZE_MB` - maximum upload size in MB, default `25`.
- `ALLOWED_UPLOAD_EXTENSIONS` - comma-separated allowlist for upload extensions.
- `UPLOADS_DIR` - backend storage path for local uploads, default `/data/uploads`.

## Useful Docker Compose Commands

```powershell
docker compose up -d --build
docker compose ps
docker compose logs -f backend
docker compose logs -f frontend
docker compose down
```

## Verification

```powershell
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
