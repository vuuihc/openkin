# syntax=docker/dockerfile:1

# Kin Hub image.
#
# The console is embedded from the committed web/dist tree, so this builds Go
# only. That matches how the rest of the repo treats the UI embed: `make ui`
# regenerates it and the result is committed. Run `make ui` before building the
# image if you changed anything under ui/.

FROM golang:1.26-alpine AS build
WORKDIR /src

# Module downloads are cached independently of the source tree, so editing Go
# code does not re-download the dependency graph.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

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
