FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared
COPY --chown=node:node public ./public
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 HOSTING_MODE=dedicated
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
