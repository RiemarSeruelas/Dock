FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS web
COPY . .
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
