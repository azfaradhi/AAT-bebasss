FROM node:20-alpine AS builder
WORKDIR /app
COPY shared-types ./shared-types
WORKDIR /app/services/storage-unit
COPY services/storage-unit/package*.json ./
RUN npm ci
COPY services/storage-unit/tsconfig.json ./
COPY services/storage-unit/src ./src
COPY services/storage-unit/test-support ./test-support
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/services/storage-unit
COPY services/storage-unit/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/services/storage-unit/dist ./dist
USER node
EXPOSE 8100
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${STORAGE_UNIT_PORT:-8100}/healthz || exit 1
CMD ["node", "dist/services/storage-unit/src/index.js"]
