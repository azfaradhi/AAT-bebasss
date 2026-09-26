# Build context is the repo root (so shared-types/ is reachable): see docker-compose.yml
FROM node:20-alpine AS builder
WORKDIR /app
COPY shared-types ./shared-types
WORKDIR /app/services/consumers/notifier
COPY services/consumers/notifier/package*.json ./
RUN npm ci
COPY services/consumers/notifier/tsconfig.json ./
COPY services/consumers/notifier/src ./src
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/services/consumers/notifier
COPY services/consumers/notifier/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/services/consumers/notifier/dist ./dist
USER node
EXPOSE 8093
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${NOTIFIER_CONSUMER_PORT:-8093}/health || exit 1
CMD ["node", "dist/services/consumers/notifier/src/index.js"]
