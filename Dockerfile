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

# NEXT_PUBLIC_* vars are baked into the client bundle at build time.
# NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY must be passed as --build-arg.
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY

# Static Clerk routing vars — same in every environment.
ENV NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
ENV NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
ENV NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/
ENV NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/

RUN npm run build

# ── stage 3: runner ───────────────────────────────────────────────────────────
FROM node:20-slim AS runner
WORKDIR /app

# Copy standalone Next.js server and its bundled node_modules
COPY --from=builder /app/.next/standalone ./
# Static assets and public must sit next to server.js
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# playwright is in serverExternalPackages auto-list so Next.js does not bundle it.
# Copy it explicitly from deps so it is available at runtime as a native module.
COPY --from=deps /app/node_modules/playwright ./node_modules/playwright
COPY --from=deps /app/node_modules/playwright-core ./node_modules/playwright-core

# Install Chromium system libraries and the browser binary.
# PLAYWRIGHT_BROWSERS_PATH pins the install location so it is consistent between
# the RUN layer (build time) and the CMD (runtime).
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/ms-playwright
RUN node node_modules/playwright/cli.js install-deps chromium \
 && node node_modules/playwright/cli.js install chromium

ENV NODE_ENV=production
# Listen on all interfaces (required in containers)
ENV HOSTNAME=0.0.0.0
# Cloud Run sets PORT=8080; Next.js standalone server.js respects PORT
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
