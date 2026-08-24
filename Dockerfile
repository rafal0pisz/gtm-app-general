# ── stage 1: deps ─────────────────────────────────────────────────────────────
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── stage 2: builder ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

# ── stage 3: runner ───────────────────────────────────────────────────────────
FROM node:20-slim AS runner
WORKDIR /app

# Copy standalone Next.js server and its bundled node_modules
COPY --from=builder /app/.next/standalone ./
# Static assets and public must sit next to server.js
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

ENV NODE_ENV=production
# Listen on all interfaces (required in containers)
ENV HOSTNAME=0.0.0.0
# Cloud Run sets PORT=8080; Next.js standalone server.js respects PORT
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
