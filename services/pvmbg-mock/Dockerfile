FROM node:20-alpine AS builder
WORKDIR /app
COPY shared-types ./shared-types
WORKDIR /app/services/pvmbg-mock
COPY services/pvmbg-mock/package*.json ./
RUN npm ci
COPY services/pvmbg-mock/tsconfig.json ./
COPY services/pvmbg-mock/src ./src
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/services/pvmbg-mock
COPY services/pvmbg-mock/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/services/pvmbg-mock/dist ./dist
USER node
EXPOSE 8082
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PVMBG_PORT:-8082}/health || exit 1
CMD ["node", "dist/services/pvmbg-mock/src/index.js"]
