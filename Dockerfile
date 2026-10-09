# npm 12 honours min-release-age in .npmrc (the base image ships npm 10).
# Pin an exact version: bump it deliberately, once it is a few days old.
ARG NPM_VERSION=12.2.0

FROM node:22-alpine AS builder
ARG NPM_VERSION

WORKDIR /app

# Install build dependencies for better-sqlite3 native bindings
RUN apk add --no-cache python3 make g++

RUN npm install -g npm@${NPM_VERSION}

COPY package*.json .npmrc ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production image
FROM node:22-alpine
ARG NPM_VERSION

WORKDIR /app

RUN apk add --no-cache python3 make g++

RUN npm install -g npm@${NPM_VERSION}

COPY package*.json .npmrc ./
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
