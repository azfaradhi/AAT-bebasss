FROM node:20-alpine AS builder
WORKDIR /app
COPY shared-types ./shared-types
COPY services/aggregator/src/ingest ./services/aggregator/src/ingest
WORKDIR /app/services/satellite-processor
COPY services/satellite-processor/package*.json ./
RUN npm ci && ln -s /app/services/satellite-processor/node_modules /app/services/aggregator/node_modules
COPY services/satellite-processor/tsconfig.json ./
COPY services/satellite-processor/src ./src
COPY services/satellite-processor/test-support ./test-support
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/services/satellite-processor
COPY services/satellite-processor/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/services/satellite-processor/dist ./dist
USER node
EXPOSE 8094
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${SATELLITE_PORT:-8094}/health || exit 1
CMD ["node", "dist/services/satellite-processor/src/index.js"]
