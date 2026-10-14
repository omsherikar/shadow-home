# The Echo Show host (packages/host) for Cloud Run: Next.js's self-contained server.
# Build from the repo root: docker build -f packages/host/Dockerfile .
# Settings arrive at run time: MCP_SERVER_URL, ANTHROPIC_API_KEY, ELEVENLABS_API_KEY (and the
# optional overrides in docs/deploy.md).

FROM node:22-slim AS build
WORKDIR /repo
COPY . .
RUN npm ci --no-audit --no-fund
RUN NEXT_OUTPUT=standalone npm run build -w @shadow-home/host

FROM node:22-slim
ENV NODE_ENV=production PORT=8080 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/packages/host/.next/standalone ./
COPY --from=build --chown=node:node /repo/packages/host/.next/static ./packages/host/.next/static
# Every turn reads the demo script (its lines and recorded plans) from ../../fixtures.
COPY --from=build --chown=node:node /repo/fixtures/demo-script.json ./fixtures/demo-script.json
WORKDIR /app/packages/host
USER node
EXPOSE 8080
CMD ["node", "server.js"]
