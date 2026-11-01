FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --only=production
COPY . .
RUN mkdir -p /data
ENV YOURTUBE_DB_PATH=/data/yourtube.sqlite
ENV NODE_ENV=production
EXPOSE 3457
CMD ["node", "server.js"]
