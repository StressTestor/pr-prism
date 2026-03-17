FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production=false

COPY tsconfig.json biome.json ./
COPY src/ src/
COPY prism.config.yaml .env.example ./

RUN npm run build && npm prune --production

ENTRYPOINT ["node", "dist/cli.js"]
