FROM node:22-slim

WORKDIR /app

# Install dependencies first so this layer caches unless package files change
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy application code
COPY index.js session.js providers.js mediaauth.js release.js verify.js ./

# The auth service listens on 8010
EXPOSE 8010

CMD ["node", "index.js"]
