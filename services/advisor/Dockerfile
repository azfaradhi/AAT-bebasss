FROM node:20-alpine AS builder
WORKDIR /app
COPY shared-types ./shared-types
WORKDIR /app/services/advisor
COPY services/advisor/package*.json ./
RUN npm ci
COPY services/advisor/tsconfig.json ./
COPY services/advisor/src ./src
COPY services/advisor/test-support ./test-support
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/services/advisor
COPY services/advisor/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/services/advisor/dist ./dist
USER node
EXPOSE 8097
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${ADVISOR_PORT:-8097}/health || exit 1
CMD ["node", "dist/services/advisor/src/index.js"]
