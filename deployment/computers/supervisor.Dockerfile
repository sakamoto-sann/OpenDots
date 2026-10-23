# syntax=docker/dockerfile:1
# Supply the existing Takumi-guard npmrc as a BuildKit secret; never embed registry credentials.
# Source comes from the exact OpenBot revision in compose.computers.yml.
FROM oven/bun:1.4.4-alpine
COPY deployment/security/ /opt/security-ca/
ENV SSL_CERT_FILE=/opt/security-ca/ca.pem SSL_CERT_DIR=/opt/security-ca/empty-ca-dir REQUESTS_CA_BUNDLE=/opt/security-ca/ca.pem CURL_CA_BUNDLE=/opt/security-ca/ca.pem PIP_CERT=/opt/security-ca/ca.pem
WORKDIR /app
COPY --from=openbot supervisor/package.json supervisor/bun.lock ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true bun /opt/security-ca/guard-lock.mjs bun.lock && bun install --ignore-scripts --frozen-lockfile
COPY --from=openbot supervisor/src ./src
COPY deployment/computers/LICENSE.openbot ./LICENSE.openbot
COPY deployment/computers/harden-supervisor.mjs /tmp/harden-supervisor.mjs
RUN bun /tmp/harden-supervisor.mjs /app/src/environment.ts /app/src/docker.ts && rm /tmp/harden-supervisor.mjs
EXPOSE 4300
CMD ["bun", "src/index.ts"]
