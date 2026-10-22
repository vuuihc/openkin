# syntax=docker/dockerfile:1

# Kin Hub image.
#
# Three stages, and the first one is not optional. Vite's output is gitignored:
# the repository commits web/dist/index.html but none of the hashed bundles it
# points at, because `make build` and CI regenerate them. So a clone does not
# contain a working console, and an image built straight from a clone would
# serve an index.html whose script 404s, which is a blank page and a confusing
# one. Building the console here is what makes `docker compose up -d --build`
# work on a fresh machine, which is the entire audience for this file.
#
# The image therefore also cannot drift from ui/: it is compiled from the same
# source in the same build, not from whatever a working tree happened to hold.

FROM node:22-alpine AS ui
WORKDIR /src/ui
# Dependencies are cached independently of the source, so editing a component
# does not re-run npm ci.
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
# Writes to ../web/dist, which is where go:embed expects it.
RUN npm run build

FROM golang:1.26-alpine AS build
WORKDIR /src

# Module downloads are cached independently of the source tree, so editing Go
# code does not re-download the dependency graph.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# The console comes from the ui stage. web/dist is excluded from the build
# context, so this is the only way it gets in, and nothing stale can survive.
COPY --from=ui /src/web/dist ./web/dist

ARG VERSION=dev
# CGO is off so the binary is fully static: it runs on this Alpine base and on
# any other base without a matching libc. modernc.org/sqlite is pure Go, so
# nothing here needs a C toolchain.
RUN CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w -X main.version=${VERSION}" \
      -o /out/kin ./cmd/kin

FROM alpine:3.21

# ca-certificates is required, not cosmetic: the Hub calls out to an OIDC
# provider over HTTPS and to Let's Encrypt's ACME directory.
RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -u 1000 -h /data kin \
 && install -d -o kin -g kin /data

COPY --from=build /out/kin /usr/local/bin/kin

# The state directory is a volume. Nothing durable is written into the image
# layer: the database, the daemon token, the ACME account key, and the
# certificate cache all live under here.
ENV KIN_STATE_DIR=/data
VOLUME ["/data"]

# 80 serves ACME HTTP-01 challenges and redirects to HTTPS. 443 serves the
# console. 7777 is the loopback listener, deliberately not published: it is how
# `docker compose exec kin kin ...` reaches a running daemon.
EXPOSE 80 443

USER kin
# --domain is required for the hub role and comes from the compose file.
ENTRYPOINT ["kin"]
CMD ["serve", "--role", "hub"]
