# The API server. Build from the repository root:
#   docker build -t unbait-server .
FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --prod --filter @unbait/server...
COPY packages/core packages/core
COPY apps/server apps/server
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
WORKDIR /app/apps/server
CMD ["node", "--import", "tsx", "src/index.ts"]
