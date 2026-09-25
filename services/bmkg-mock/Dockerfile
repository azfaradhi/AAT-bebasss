FROM node:20-alpine

WORKDIR /app

# Copy shared-types first
COPY shared-types ./shared-types

# Copy service package.json
COPY services/bmkg-mock/package*.json ./services/bmkg-mock/

WORKDIR /app/services/bmkg-mock
RUN npm install

# Copy service source
COPY services/bmkg-mock/tsconfig.json ./
COPY services/bmkg-mock/src ./src

# Expose port
EXPOSE 8081

# Run with tsx (or we could build and run node dist/index.js)
CMD ["npx", "tsx", "src/index.ts"]
