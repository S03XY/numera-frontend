# ---- Stage 1: build ----
FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
# `ci` not `install`: the Unlink SDK is pinned to a canary build, and only the
# lockfile records which one. `install` is free to resolve a newer canary.
RUN npm ci

COPY . .

# Next inlines every NEXT_PUBLIC_* value into the client bundle AT BUILD TIME, so
# .env.production has to be present in this stage, not just at runtime. Editing it
# later means rebuilding the image: `docker compose up -d --build frontend`.
RUN npm run build

# ---- Stage 2: runtime ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# node_modules is carried over whole rather than pruned. `next start` loads
# next.config.ts through the TypeScript compiler, which lives in devDependencies,
# so pruning them breaks boot with an error that names neither.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/.env.production ./.env.production

EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
