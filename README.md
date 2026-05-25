# OfficeChat

OfficeChat is an open-source, self-hosted corporate chat for local networks and private environments. The project is designed to work well in LAN/offline deployments first, while keeping the architecture ready for secure internet-facing deployments later.

Current status: early development. This repository currently contains the initial Dockerized scaffold only. Full chat, authentication, WebSocket messaging, LDAP/AD, and production nginx configuration are not implemented yet.

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

Groups foundation is available without chat messages yet. Admins can create groups, group owners can manage members, and regular users can see groups where they are members.

Important auth environment variables:

- `APP_SECRET_KEY` - development placeholder is included in `.env.example`; change it for any shared or production deployment.
- `ACCESS_TOKEN_EXPIRE_MINUTES` - local bearer token lifetime.
- `BOOTSTRAP_SUPERADMIN_USERNAME`
- `BOOTSTRAP_SUPERADMIN_PASSWORD`
- `BOOTSTRAP_SUPERADMIN_DISPLAY_NAME`

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
