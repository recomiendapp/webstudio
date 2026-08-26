# --- Étape 1 : build ---
FROM node:22-alpine AS build 
WORKDIR /app

# System deps needed for native modules (prisma, etc.) during install/build
RUN apk add --no-cache \
    bash \
    libc6-compat \
    openssl \
    openssl-dev \
    curl \
    git \
    make \
    g++ \
    python3

# Pin pnpm to the version declared in package.json (packageManager field)
RUN corepack enable && corepack prepare pnpm@9.14.4 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./ 
COPY vite.*.ts ./ 
COPY patches ./patches 
COPY apps ./apps 
COPY packages ./packages

RUN pnpm install --frozen-lockfile

RUN mkdir -p /app/https && \
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
      -keyout /app/https/privkey.pem \
      -out /app/https/fullchain.pem \
      -subj "/CN=localhost"

ENV HTTPS_DISABLE=true 
RUN pnpm -r --filter "@webstudio-is/builder..." run build

# --- Étape 2 : runtime ---
FROM node:22-alpine 
WORKDIR /app 
RUN apk add --no-cache \
    bash \
    libc6-compat \
    openssl \
    openssl-dev \
    curl \
    git \
    make \
    g++ \
    python3
RUN corepack enable && corepack prepare pnpm@9.14.4 --activate
COPY --from=build /app ./ 
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh
ENV TRUST_PROXY=true
ENV PROTOCOL=https
ENV NODE_ENV=production 
ENV HOST=0.0.0.0 
# Must match traefik loadbalancer.server.port in docker-compose (3000)
ENV PORT=3000
ENV PUBLIC_URL=https://builder.recomiend.app
ENV APP_URL=https://builder.recomiend.app

CMD ["/app/start.sh"]