# One image for the API, worker and back office; a Caddy image that also serves the till web app.
FROM node:22-bookworm-slim AS app
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN npm ci
# The pairing code and browser need the public API address at build time.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && npx next build
RUN cd apps/pos && npx expo export -p web --output-dir dist
ENV NODE_ENV=production

FROM caddy:2 AS proxy
COPY --from=app /app/apps/pos/dist /srv/till
COPY deploy/Caddyfile /etc/caddy/Caddyfile
