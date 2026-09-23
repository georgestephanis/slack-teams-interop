FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3 native bindings
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production image
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY public ./public
COPY manifests ./manifests

ENV NODE_ENV=production
ENV PORT=3978
ENV HOST=0.0.0.0
ENV DATABASE_PATH=/data/bridge.sqlite

EXPOSE 3978

VOLUME ["/data"]

CMD ["node", "dist/index.js"]
