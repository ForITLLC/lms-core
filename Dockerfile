# Self-hosted image built from the exported LMS tree.
# Targets:
#   runtime (default)  the Next.js standalone server on port 3000
#   tools              the migration runner and tenant bootstrap (db/migrations, mssql only)
#
#   docker build -t forit-lms .
ARG NODE_VERSION=20

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /src/forit-LMS
COPY package.json package-lock.json .npmrc ./
COPY vendor/foritllc-auth/ ./vendor/foritllc-auth/
RUN npm ci --no-audit --no-fund
COPY . .
ARG GIT_SHA=
ENV GIT_SHA=${GIT_SHA} NEXT_TELEMETRY_DISABLED=1
RUN npm run build \
 && cp -R .next/static .next/standalone/.next/static \
 && cp -R public .next/standalone/public \
 && test -f .next/standalone/server.js

FROM node:${NODE_VERSION}-bookworm-slim AS tools
WORKDIR /app
RUN npm init -y >/dev/null && npm install --no-audit --no-fund --omit=dev mssql@10.0.4 && npm cache clean --force
COPY scripts/run-migration.cjs scripts/bootstrap-tenant.cjs scripts/selfhost-init.cjs scripts/
COPY db/migrations db/migrations
USER node
CMD ["node", "scripts/selfhost-init.cjs"]

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /src/forit-LMS/.next/standalone ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]
