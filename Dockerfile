FROM node:24-alpine
WORKDIR /app
COPY package.json server.ts ./
COPY api ./api
EXPOSE 8645
CMD ["node", "server.ts"]
