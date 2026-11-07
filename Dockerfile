FROM oven/bun:1.4.4
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY bunfig.toml main.ts ./
COPY src ./src
USER bun
CMD ["bun", "main.ts"]
