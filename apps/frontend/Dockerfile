FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

FROM deps AS development

RUN apk add --no-cache chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev"]

FROM deps AS builder

ARG NEXT_PUBLIC_DEFAULT_LOCALE=ru
ARG NEXT_PUBLIC_BACKEND_URL=http://localhost:8100
ARG NEXT_PUBLIC_PRESENCE_HEARTBEAT_SECONDS=25
ARG NEXT_PUBLIC_OFFICECHAT_VERSION=0.1.0-rc1
ENV NEXT_PUBLIC_DEFAULT_LOCALE=$NEXT_PUBLIC_DEFAULT_LOCALE
ENV NEXT_PUBLIC_BACKEND_URL=$NEXT_PUBLIC_BACKEND_URL
ENV NEXT_PUBLIC_PRESENCE_HEARTBEAT_SECONDS=$NEXT_PUBLIC_PRESENCE_HEARTBEAT_SECONDS
ENV NEXT_PUBLIC_OFFICECHAT_VERSION=$NEXT_PUBLIC_OFFICECHAT_VERSION

COPY . .

RUN npm run build

FROM node:20-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

WORKDIR /app

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
