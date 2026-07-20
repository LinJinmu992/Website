FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    ASTRO_TELEMETRY_DISABLED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 0700 -o node -g node /home/node/.ssh

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev \
    && npm cache clean --force \
    && chown -R node:node /app/node_modules

COPY --chown=node:node . .

USER node

EXPOSE 4322

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const s=require('node:net').connect(4322,'127.0.0.1');s.setTimeout(3000);s.on('connect',()=>{s.end();process.exit(0)});s.on('timeout',()=>process.exit(1));s.on('error',()=>process.exit(1))"]

CMD ["npm", "run", "admin"]
