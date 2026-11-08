# Zero npm dependencies: the app uses Node's built-in http and sqlite modules.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY src ./src

# SQLite data lives in /data. Mount a persistent volume there so requests survive redeploys.
# (Runs as root so a platform-mounted volume at /data is always writable.)
RUN mkdir -p /data
ENV DATA_DIR=/data

EXPOSE 3000

CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.js"]
