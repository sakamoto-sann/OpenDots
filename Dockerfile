FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 DATABASE_PATH=/data/opendots.sqlite
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir -p /data && chown node:node /data
COPY --from=build /app/dist ./dist
USER node
EXPOSE 4310
CMD ["node", "dist/server/server/index.js"]

FROM node:24-bookworm-slim AS browser
ENV NODE_ENV=production BROWSER_HOST=0.0.0.0 BROWSER_PORT=4311 BROWSER_EXECUTABLE_PATH=/usr/bin/chromium BROWSER_CHROMIUM_SANDBOX=0
ENV XDG_CONFIG_HOME=/tmp/chromium-config XDG_CACHE_HOME=/tmp/chromium-cache
WORKDIR /app
COPY package*.json ./
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && npm ci --omit=dev
COPY --from=build /app/dist/server ./dist/server
USER node
EXPOSE 4311
CMD ["node", "dist/server/browser/index.js"]

FROM node:24-bookworm-slim AS command-runner
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*
COPY deployment/computers/command-runner.c /tmp/command-runner.c
RUN gcc -O2 -Wall -Wextra -Werror /tmp/command-runner.c -o /command-runner

# Persistent Stagehand computer; no model or host credentials are installed here.
FROM browser AS computer
USER root
RUN mkdir -p /workspace /profiles && chown node:node /workspace /profiles
ENV PORT=4100 OPENDOTS_COMPUTER_CONTAINER=1
COPY --from=command-runner /command-runner /app/command-runner
COPY deployment/computers/stagehand-entrypoint.sh /app/stagehand-entrypoint.sh
USER node
EXPOSE 4100
ENTRYPOINT ["/bin/sh", "/app/stagehand-entrypoint.sh"]
