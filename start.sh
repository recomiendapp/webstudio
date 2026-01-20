#!/usr/bin/env sh
set -e

WS_NAME="@webstudio-is/builder" 
APP_DIR="/app" 
BUILD_DIR="${APP_DIR}/apps/builder/build" 

echo "Checking build directory: ${BUILD_DIR}"

# (1) S'il n'y a pas encore de build, lance le build (builder + deps)
if [ ! -d "${BUILD_DIR}" ] || [ -z "$(ls -A "${BUILD_DIR}" 2>/dev/null)" ]; then 
  echo "No build found. Building ${WS_NAME} (and deps)"
  pnpm -r --filter "${WS_NAME}..." run build 
fi

# (2) Migraciones (PRODUCCIÓN)
echo "Running database migrations (deploy mode)"
pnpm --filter=@webstudio-is/prisma-client generate
pnpm --filter=./packages/prisma-client migrations migrate ../../apps/builder

# (2) Détecter l'entry serveur Remix : - priorité: build/server/**/index.js (Remix v2) - fallback: build/index.js (anciens templates)
SSR_ENTRY=""
if [ -f "${BUILD_DIR}/server/index.js" ]; then 
  SSR_ENTRY="${BUILD_DIR}/server/index.js" 
else
  # cherche le premier index.js sous build/server/*/index.js
  CANDIDATE=$(find "${BUILD_DIR}/server" -type f -name "index.js" -print 2>/dev/null | head -n 1 || true) 
  if [ -n "${CANDIDATE}" ]; then 
    SSR_ENTRY="${CANDIDATE}" 
  elif [ -f "${BUILD_DIR}/index.js" ]; then
    SSR_ENTRY="${BUILD_DIR}/index.js" 
  fi 
fi
 
if [ -z "${SSR_ENTRY}" ] || [ ! -f "${SSR_ENTRY}" ]; then 
  echo "Remix server entry not found."
  echo "Current build tree:"
  find "${BUILD_DIR}" -maxdepth 3 -type d -print 
  echo "Files under build/server:"
  find "${BUILD_DIR}/server" -maxdepth 3 -type f -name "index.js" -print 2>/dev/null || true 
  exit 1
fi
 
echo "Using server entry: ${SSR_ENTRY}"
# A esto (añadiendo el puerto explícitamente):
echo "Starting remix-server on port ${PORT:-3001}"
PORT=3001 exec pnpm --filter "${WS_NAME}" exec remix-serve "${SSR_ENTRY}"