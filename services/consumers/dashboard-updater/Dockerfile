FROM node:20-alpine AS builder
WORKDIR /app
COPY shared-types ./shared-types
WORKDIR /app/services/consumers/dashboard-updater
COPY services/consumers/dashboard-updater/package*.json ./
RUN npm ci
COPY services/consumers/dashboard-updater/tsconfig.json ./
COPY services/consumers/dashboard-updater/src ./src
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/services/consumers/dashboard-updater
COPY services/consumers/dashboard-updater/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/services/consumers/dashboard-updater/dist ./dist
USER node
EXPOSE 8092
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${DASHBOARD_CONSUMER_PORT:-8092}/health || exit 1
CMD ["node", "dist/services/consumers/dashboard-updater/src/index.js"]
