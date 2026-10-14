# The MCP server for Google Cloud Run (src/cloud-run.ts), built from the repository root:
#   docker build -f packages/server/Dockerfile -t shadow-home-server .
# The first stage installs the workspace and bundles the server; the image holds only the bundle
# and the view it serves.
FROM node:22-slim AS build
WORKDIR /repo
COPY . .
RUN npm ci --no-audit --no-fund
RUN node packages/infra/scripts/bundle.ts cloud-run

FROM node:22-slim
ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps
WORKDIR /app
COPY --from=build --chown=node:node /repo/packages/infra/dist/cloud-run ./
USER node
EXPOSE 8080
CMD ["node", "server/index.mjs"]
