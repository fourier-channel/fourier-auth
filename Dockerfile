FROM node:22-slim

WORKDIR /app

# Install dependencies first so this layer caches unless package files change
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy ALL application source. Glob (not an explicit allowlist) so a newly added
# module can never be silently left out of the image -- that omission crash-looped
# the container three times (autotagger.js, release.js, verify.js). Test files are
# kept out via .dockerignore (*.test.js).
COPY *.js ./

# The auth service listens on 8010
EXPOSE 8010

CMD ["node", "index.js"]
