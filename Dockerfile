# Zero npm dependencies: the app uses Node's built-in http and sqlite modules.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY src ./src

# SQLite data lives in /data. Mount a persistent volume there so requests survive redeploys.
RUN mkdir -p /data && chown -R node:node /data /app
ENV DATA_DIR=/data

USER node
EXPOSE 3000

CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.js"]
