FROM node:20-alpine AS builder
WORKDIR /app
COPY shared-types ./shared-types
WORKDIR /app/services/client-api
COPY services/client-api/package*.json ./
RUN npm ci
COPY services/client-api/tsconfig.json ./
COPY services/client-api/src ./src
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/services/client-api
COPY services/client-api/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/services/client-api/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${CLIENT_API_PORT:-8080}/health || exit 1
CMD ["node", "dist/services/client-api/src/index.js"]
