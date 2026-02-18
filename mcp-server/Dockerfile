FROM node:18-alpine

WORKDIR /app

RUN apk add --no-cache curl

COPY package.json package-lock.json* ./
RUN npm ci --only=production 2>/dev/null || npm install --only=production

COPY src/ ./src/

USER node

CMD ["node", "src/index.js"]
