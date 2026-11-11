FROM oven/bun:1.1 AS deps
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

FROM oven/bun:1.1 AS runner
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV PORT=3847
EXPOSE 3847
CMD ["bun", "run", "src/main.ts"]
