FROM node:22-alpine AS base
WORKDIR /app
ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_FETCH_TIMEOUT=300000 \
    NPM_CONFIG_MAXSOCKETS=5
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --prefer-offline

FROM base AS web
COPY . .
ENV API_INTERNAL_URL=http://api:3001
RUN npm run build
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "run", "start"]

FROM base AS api
COPY server ./server
RUN mkdir -p /app/uploads /app/data
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "server/index.js"]
