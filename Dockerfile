FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npx", "tsx", "src/server.ts"]
