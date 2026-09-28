# Web-Version von Study Organizer als Container.
# Bauen:   docker build -t study-organizer .
# Starten: siehe docker-compose.yml bzw. docs/webapp.md
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Electron wird für die Web-Version nicht gebraucht
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci
COPY . .
RUN npm run web:build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/out/web ./out/web
COPY --from=build /app/out/server ./out/server
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/auth/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "out/server/index.js"]
