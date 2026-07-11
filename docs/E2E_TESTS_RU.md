# E2E tests

OfficeChat использует Vitest для unit/component tests и Playwright для browser smoke tests.

Команда:

```bash
docker compose exec frontend npm run test:e2e
```

Playwright запускает Chromium headless, сохраняет screenshots/video/trace при failure.

## Safety

E2E tests не должны запускаться против production без явного разрешения:

```bash
E2E_ALLOW_DESTRUCTIVE_TESTS=true
```

По умолчанию destructive authenticated smoke flows пропускаются. Для локального RC smoke можно включить:

```bash
docker compose exec -e E2E_ALLOW_DESTRUCTIVE_TESTS=true frontend npm run test:e2e
```

## Current smoke coverage

- frontend `/api/health`;
- localized login page;
- invalid login;
- guarded admin login and app shell open.

## Planned critical flows

- group/direct/discussion message exchange in two sessions;
- unread/read receipt clearing;
- presence status transition;
- search and jump-to-message;
- granular permissions;
- pins;
- broadcasts;
- audit log checks.

Тестовые аккаунты должны иметь предсказуемые имена и не должны использовать production data.
