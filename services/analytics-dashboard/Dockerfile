FROM node:20-alpine AS builder
WORKDIR /app
COPY shared-types ./shared-types
WORKDIR /app/services/analytics-dashboard
COPY services/analytics-dashboard/package*.json ./
RUN npm ci
COPY services/analytics-dashboard/tsconfig.json ./
COPY services/analytics-dashboard/src ./src
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/services/analytics-dashboard
COPY services/analytics-dashboard/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/services/analytics-dashboard/dist ./dist
USER node
EXPOSE 8110
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${ANALYTICS_DASHBOARD_PORT:-8110}/healthz || exit 1
CMD ["node", "dist/services/analytics-dashboard/src/index.js"]
