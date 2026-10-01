FROM node:20-alpine AS builder
WORKDIR /app
COPY shared-types ./shared-types
WORKDIR /app/services/bmkg-mock
COPY services/bmkg-mock/package*.json ./
RUN npm ci
COPY services/bmkg-mock/tsconfig.json ./
COPY services/bmkg-mock/src ./src
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/services/bmkg-mock
COPY services/bmkg-mock/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/services/bmkg-mock/dist ./dist
USER node
EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${BMKG_PORT:-8081}/health || exit 1
CMD ["node", "dist/services/bmkg-mock/src/index.js"]
