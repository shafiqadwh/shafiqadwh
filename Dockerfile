# Xpenology/Synology NAS boxes are x86-64; pin the platform so a build on an
# Apple Silicon laptop still produces an image the NAS can run.
FROM --platform=linux/amd64 node:22-bookworm-slim AS deps

WORKDIR /app

# Toolchain for better-sqlite3 / sharp when no prebuilt binary matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev


FROM --platform=linux/amd64 node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=3000 \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe

# System ffmpeg rather than the npm download: it is what actually gets used at
# runtime, and it keeps the image working even if the optional npm binaries
# could not be fetched during the build.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY views ./views
COPY public ./public
COPY locales ./locales

RUN mkdir -p /app/data/uploads /app/data/derived /app/data/db /app/data/tmp \
  && chown -R node:node /app/data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
