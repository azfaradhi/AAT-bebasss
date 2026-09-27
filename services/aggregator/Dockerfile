FROM node:20-alpine AS builder
WORKDIR /app
COPY shared-types ./shared-types
WORKDIR /app/services/aggregator
COPY services/aggregator/package*.json ./
RUN npm ci
COPY services/aggregator/tsconfig.json ./
COPY services/aggregator/src ./src
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/services/aggregator
COPY services/aggregator/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/services/aggregator/dist ./dist
USER node
EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${AGGREGATOR_PORT:-8090}/health || exit 1
CMD ["node", "dist/services/aggregator/src/index.js"]
