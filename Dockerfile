# Zero npm dependencies: the app uses Node's built-in http and sqlite modules.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY src ./src

# SQLite data lives here. Mount a volume at /data to survive container replacement.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
ENV DATA_DIR=/data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.js"]
