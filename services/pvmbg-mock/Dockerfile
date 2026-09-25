FROM node:20-alpine

WORKDIR /app

# Copy shared-types
COPY shared-types ./shared-types

# Copy service package.json
COPY services/pvmbg-mock/package*.json ./services/pvmbg-mock/

WORKDIR /app/services/pvmbg-mock
RUN npm install

# Copy service source
COPY services/pvmbg-mock/tsconfig.json ./
COPY services/pvmbg-mock/src ./src

# Expose port
EXPOSE 8082

# Run with tsx
CMD ["npx", "tsx", "src/index.ts"]
