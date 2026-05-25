# OfficeChat

OfficeChat is an open-source, self-hosted corporate chat for local networks and private environments. The project is designed to work well in LAN/offline deployments first, while keeping the architecture ready for secure internet-facing deployments later.

Current status: early development. This repository currently contains the Dockerized scaffold, local authentication, admin user management, groups, REST group messages, basic WebSocket real-time updates, and local file attachments for group messages. Direct messages, LDAP/AD, S3/object storage, antivirus scanning, and production nginx configuration are not implemented yet.

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

Groups foundation is available. Admins can create groups, group owners can manage members, and regular users can see groups where they are members.

Messages foundation is available on group detail pages. REST API remains the source of truth:

- `GET /api/groups/{group_id}/messages`
- `POST /api/groups/{group_id}/messages`
- `PATCH /api/groups/{group_id}/messages/{message_id}`
- `DELETE /api/groups/{group_id}/messages/{message_id}`

Members can read and send messages in their groups. Message authors can edit and delete their own messages. Group owners, group moderators, `admin`, and `superadmin` users can delete messages according to the current permission model.

WebSocket real-time updates are available for group messages:

- `WS /api/ws/groups/{group_id}?token=...`
- Development clients pass the JWT token in the query string.
- Sending still happens through REST; WebSocket only receives `message.created`, `message.updated`, and `message.deleted` events.
- Current WebSocket manager is single-instance only. Multi-instance production should use Valkey pub/sub or another broker later.
- Typing indicators, read receipts, direct messages, and reactions are not implemented yet.

File attachments are available for group messages:

- `POST /api/groups/{group_id}/messages/with-attachment`
- `GET /api/groups/{group_id}/attachments/{attachment_id}/download`
- Files are stored in the backend uploads Docker volume mounted at `/data/uploads`.
- Upload defaults: `MAX_UPLOAD_SIZE_MB=25`.
- Allowed extensions default to `pdf,doc,docx,xls,xlsx,png,jpg,jpeg,txt,zip`.
- Antivirus scanning, previews, thumbnails, drag-and-drop, S3, and retention cleanup are not implemented yet.

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
