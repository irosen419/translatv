# Multi stage: build everything, ship only what runs.
#
# The client is built into static files the server serves, so this is one image and one process
# rather than two services that have to find each other.

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

COPY shared/ shared/
COPY server/ server/
COPY client/ client/
# script/ holds the build gates. Leaving it out made check_secrets.mjs die with MODULE_NOT_FOUND,
# which the old `||` fallback then reported as a credential leak: a security failure that had not
# happened. Copy it, and let the script speak for itself.
COPY script/ script/

RUN npm run build --workspace=shared \
 && npm run build --workspace=server \
 && npm run build --workspace=client

# Refuse to ship an image with a credential baked into the public bundle. This is the VITE_
# prefix trap: it would leak silently, with no error at build time and no warning at runtime.
#
# Deliberately NOT wrapped in `|| echo ...`. That construct turns every non-zero exit into the
# same message, so a crashed script reads as a leaked key and the real cause is buried. A
# non-zero exit here already fails the build; the script's own output says which failure it was.
RUN node script/check_secrets.mjs

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
RUN npm ci --omit=dev --workspace=shared --workspace=server && npm cache clean --force

COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist

# The spend ledger. The cap gate REFUSES to spend when it cannot read this file, so an image
# without it would block every translation rather than failing open.
#
# --chown is not cosmetic. Without it the ledger arrives root owned, USER node below cannot append
# to it, and every write fails EACCES for the life of the container. Nothing stopped when that
# happened: the file still existed and still parsed, so the cap gate read a stale ledger and kept
# allowing calls. Spend continued, permanently untracked, behind one warning line per call. The
# server now refuses to translate when it cannot append, and this is what stops it having to.
COPY --chown=node:node out/ out/

# Run as a non root user. Nothing here needs privileges.
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
