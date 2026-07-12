# Release checklist

Перед internal release:

- environment validation completed;
- production `.env` содержит сильный `APP_SECRET_KEY`;
- `DATABASE_URL` задан;
- `BACKEND_CORS_ORIGINS` содержит только точные origins;
- uploads volume writable;
- backup completed;
- restore test completed in isolated environment;
- migrations applied;
- `docker compose exec backend alembic current`;
- `docker compose exec backend python -m compileall app`;
- `docker compose exec backend python -m pytest -q`;
- `docker compose exec frontend npm run test:run`;
- `docker compose exec frontend npm run build`;
- `docker compose exec frontend npm run test:e2e`;
- `docker compose -f docker-compose.prod.yml config`;
- `/health` returns 200;
- `/ready` returns 200;
- CORS checked from allowed and blocked origins;
- reverse proxy configuration reviewed;
- browser smoke check completed;
- no raw secrets in logs;
- rollback plan prepared;
- database and uploads backup stored together.

Manual smoke:

1. start clean production-like stack;
2. apply migrations;
3. login as superadmin;
4. login as normal user in second browser;
5. send group message;
6. send direct message;
7. upload and download safe file;
8. verify unread and read receipt;
9. search and jump to message;
10. grant `can_pin_messages`;
11. pin and unpin message;
12. grant `can_broadcast`;
13. send and retract selected-user broadcast;
14. verify recipient unread badge;
15. verify notification bell unread count, read, read-all and dismiss;
16. verify audit events;
17. restart backend;
18. confirm sessions remain valid with unchanged secret;
19. create backup;
20. restore into isolated environment;
21. confirm restored data and attachments;
22. confirm no backend traceback.
## Calendar Events v0.1

- Проверить миграцию `20260704_0023`.
- Проверить, что `calendar-worker` запущен после применения миграций.
- Проверить `can_manage_calendar` в управлении пользователями.
- Проверить создание, перенос, отмену события и доставку напоминания.
- Проверить, что Audit Log не содержит описание, место, ссылку конференции и список получателей.
