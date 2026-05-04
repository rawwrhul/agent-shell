FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY db ./db
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY skills ./skills
RUN groupadd -r agent && useradd -r -g agent agent
RUN mkdir -p /app/agent-progress && chown -R agent:agent /app
USER agent
EXPOSE 3000
CMD ["node", "dist/src/index.js"]
