# Build context is the repo root (so shared-types/ is reachable): see docker-compose.yml
FROM node:20-alpine AS builder
WORKDIR /app
COPY shared-types ./shared-types
WORKDIR /app/services/auth-service
COPY services/auth-service/package*.json ./
RUN npm ci
COPY services/auth-service/tsconfig.json ./
COPY services/auth-service/src ./src
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/services/auth-service
COPY services/auth-service/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/services/auth-service/dist ./dist
USER node
EXPOSE 8091
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${AUTH_SERVICE_PORT:-8091}/health || exit 1
CMD ["node", "dist/services/auth-service/src/index.js"]
