FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.typecheck.json eslint.config.js vitest.config.ts ./
COPY scripts ./scripts
COPY src ./src
COPY config.example.yaml LICENSE README.md ./
RUN pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/config.example.yaml /app/LICENSE /app/README.md ./
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
USER node
ENV AI_COUNSEL_DATA_HOME=/home/node/.local/share/ai-counsel
EXPOSE 8787
ENTRYPOINT ["node", "dist/cli/main.js"]
