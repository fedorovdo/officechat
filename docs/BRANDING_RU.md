# Брендинг и страница About

OfficeChat хранит публичные сведения о продукте централизованно во frontend:

- `apps/frontend/lib/brand.ts` - название продукта, короткое имя, автор, ссылки, версия и безопасные public env overrides.
- `apps/frontend/components/Brand.tsx` - общие компоненты `BrandMark`, `BrandLogo`, `ProductWordmark`.
- `apps/frontend/public/brand/` - заменяемые SVG-исходники логотипа.
- `apps/frontend/public/favicon.ico`, `icon.svg`, `icon-192.svg`, `icon-512.svg`, `manifest.webmanifest` - иконки браузера и manifest.

Поддерживаемые публичные переменные:

```text
NEXT_PUBLIC_OFFICECHAT_VERSION
NEXT_PUBLIC_OFFICECHAT_BUILD_SHA
NEXT_PUBLIC_OFFICECHAT_BUILD_DATE
NEXT_PUBLIC_OFFICECHAT_PRODUCT_NAME
NEXT_PUBLIC_OFFICECHAT_AUTHOR_NAME
NEXT_PUBLIC_OFFICECHAT_AUTHOR_URL
NEXT_PUBLIC_OFFICECHAT_REPOSITORY_URL
NEXT_PUBLIC_OFFICECHAT_SUPPORT_EMAIL
NEXT_PUBLIC_OFFICECHAT_ORGANIZATION_NAME
```

Эти значения безопасны для отображения в браузере. Не добавляйте сюда секреты, внутренние адреса баз данных, пути контейнера, JWT-конфигурацию или приватные deployment details.

## Замена логотипа

Замените SVG-файлы в `apps/frontend/public/brand/` и иконки в `apps/frontend/public/`. Компоненты используют только публичные пути, поэтому код не зависит от конкретной формы логотипа.

## About

Страницы:

- `/ru/about`
- `/en/about`

About показывает название, описание, версию, безопасное состояние frontend `/api/health` и backend `/health`, лицензию Apache-2.0, автора и публичные ссылки. Статус загружается один раз; непрерывного polling нет.

## Health metadata

Backend `/health` возвращает только безопасные поля: `status`, `service`, `product`, `version` и опциональные build metadata. `OFFICECHAT_BUILD_SHA` отображается в сокращённом виде.

## Индексация

Frontend metadata настроен для внутреннего приложения: `noindex`, `nofollow`. Если позже появится публичная demo-инсталляция, измените robots metadata в `apps/frontend/app/layout.tsx` и убедитесь, что публичный стенд не содержит приватных данных.

