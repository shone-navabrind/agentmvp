# syntax=docker/dockerfile:1
#
# Harness Cloud — single-image build.
#
# Node 22 is required, not preferred: the source ships as TypeScript and runs through
# node's type stripping, so there is no build step and no compiled output to copy.

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8787 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# Manifests first, so a dependency install is cached across source edits. Every
# workspace manifest must be present before `npm ci` can resolve the workspace graph.
COPY package.json package-lock.json ./
COPY packages/kernel/package.json      packages/kernel/
COPY packages/flow/package.json        packages/flow/
COPY packages/blueprints/package.json  packages/blueprints/
COPY packages/harness/package.json     packages/harness/
COPY packages/compute/package.json     packages/compute/
COPY packages/sandbox/package.json     packages/sandbox/
COPY packages/board/package.json       packages/board/
COPY packages/triggers/package.json    packages/triggers/
COPY packages/billing/package.json     packages/billing/
COPY packages/plugins/package.json     packages/plugins/
COPY apps/api/package.json             apps/api/

# --omit=dev leaves out typescript, @types/node and axe-core: none are needed to run.
RUN npm ci --omit=dev --ignore-scripts

COPY packages/ packages/
COPY apps/api/ apps/api/
COPY apps/web/public/ apps/web/public/

# The image ships no credentials. The API reads none today; when it does, they arrive
# as environment variables at run time, never baked in here.
USER node

EXPOSE 8787

# Hits the real API rather than just the port, so an app that boots but cannot serve
# is reported unhealthy. Kept short: a long timeout hides a hung process.
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/v1/project').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "apps/api/src/main.ts"]
