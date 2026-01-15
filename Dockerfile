# --- Étape 1 : build ---
FROM node:20-alpine AS build 
RUN npm install -g pnpm 
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./ 
COPY vite.*.ts ./ 
COPY patches ./patches 
COPY apps ./apps 
COPY packages ./packages

RUN pnpm install --frozen-lockfile

RUN apk add --no-cache openssl && \
    mkdir -p /app/https && \
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
      -keyout /app/https/privkey.pem \
      -out /app/https/fullchain.pem \
      -subj "/CN=localhost"

ENV HTTPS_DISABLE=true 
RUN pnpm -r --filter "@webstudio-is/builder..." run build

# --- Étape 2 : runtime ---
FROM node:20-alpine 
RUN npm install -g pnpm 
WORKDIR /app 
COPY --from=build /app ./ 
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh
ENV NODE_ENV=production 
ENV HOST=0.0.0.0 
ENV PORT=3000
ENV PUBLIC_URL=https://builder.recomiend.app
ENV APP_URL=https://builder.recomiend.app

CMD ["/app/start.sh"]