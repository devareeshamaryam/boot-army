# googleapis 183 requires Node >= 22, so this uses node:22-slim (not node:20).
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "src/index.js", "--once"]
