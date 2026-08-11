FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS web
RUN apk add --no-cache bash coreutils
COPY . .
RUN npm run build
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "run", "start"]

FROM base AS api
COPY server ./server
COPY db ./db
RUN mkdir -p /app/uploads
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "server/index.js"]
