FROM node:22-alpine
LABEL org.opencontainers.image.source=https://github.com/NelsWebDev/pgmyadmin
ENV NODE_ENV=production \
    PGMA_LISTEN_HOST=0.0.0.0 \
    PGMA_LISTEN_PORT=8080 \
    PGMA_ENV_FILE=
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY src ./src
COPY public ./public
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/config >/dev/null || exit 1
CMD ["node", "server.js"]
