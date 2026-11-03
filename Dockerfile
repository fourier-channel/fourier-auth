FROM node:22-slim

WORKDIR /app

# Install dependencies first so this layer caches unless package files change
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# The npm CLI is a build tool: the service runs `node index.js` and nothing in
# the container calls npm. Left in, its bundled packages (pacote, sigstore,
# brace-expansion, ...) were 6 of this image's 7 High findings in the nightly
# vulnerability scan (2026-10-25), none of them reachable from the service.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# Copy ALL application source. Glob (not an explicit allowlist) so a newly added
# module can never be silently left out of the image -- that omission crash-looped
# the container three times (autotagger.js, release.js, verify.js). Test files are
# kept out via .dockerignore (*.test.js).
COPY *.js ./
# The tracked index declarations: read at startup to verify the live
# database actually has them (see verifySynapseIndexes).
COPY db/ ./db/

# Unprivileged. hostaudit's container-user check named this container running
# as root (2026-11-02): it holds the Synapse database credentials and answers
# every media request, and it writes nothing to disk, so it needs no uid with
# rights anywhere. 10003 and not the image's `node` (1000): uid 1000 is a real
# login on the host, and an escape should land on an account that owns nothing.
# hydra is 10001 and spectrum 10002 for the same reason.
# The group is pinned too. Left to useradd --system it is gid 999, and on 41chan
# gid 999 is systemd-journal, which reads every log on the host.
RUN groupadd --system --gid 10003 auth \
    && useradd --system --no-create-home --uid 10003 --gid auth auth
USER auth

# The auth service listens on 8010
EXPOSE 8010

CMD ["node", "index.js"]
