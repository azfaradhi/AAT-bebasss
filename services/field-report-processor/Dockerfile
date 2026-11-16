FROM node:20-alpine AS builder
WORKDIR /app
COPY shared-types ./shared-types
WORKDIR /app/services/field-report-processor
COPY services/field-report-processor/package*.json ./
RUN npm ci
COPY services/field-report-processor/tsconfig.json ./
COPY services/field-report-processor/src ./src
COPY services/field-report-processor/test-support ./test-support
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/services/field-report-processor
COPY services/field-report-processor/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/services/field-report-processor/dist ./dist
USER node
EXPOSE 8096
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${FIELD_REPORT_PORT:-8096}/health || exit 1
CMD ["node", "dist/services/field-report-processor/src/index.js"]
