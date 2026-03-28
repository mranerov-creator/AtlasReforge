FROM node:20-alpine AS development
RUN corepack enable && corepack prepare pnpm@9.14.2 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/tsconfig/package.json packages/tsconfig/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY apps/web/ apps/web/
EXPOSE 3000
CMD ["pnpm", "--filter", "@atlasreforge/web", "dev", "--host", "0.0.0.0"]

FROM development AS builder
RUN pnpm --filter @atlasreforge/web build

FROM nginx:alpine AS production
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
RUN echo 'server { listen 3000; root /usr/share/nginx/html; location / { try_files $uri $uri/ /index.html; } location /api { proxy_pass http://api:3001; } }' > /etc/nginx/conf.d/default.conf
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
