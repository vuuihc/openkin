#!/usr/bin/env bash
set -euo pipefail

REPO="vuuihc/openkin"
VERSION="${1:-latest}"
BINDIR="${BINDIR:-/usr/local/bin}"

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
    x86_64|amd64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "unsupported arch: $ARCH"; exit 1 ;;
esac

# Only macOS and Linux supported for binary distribution
if [ "$OS" != "darwin" ] && [ "$OS" != "linux" ]; then
    echo "unsupported OS: $OS (only macOS and Linux)"
    exit 1
fi

BINARY="kin-${OS}-${ARCH}"

# Map latest to latest release tag
if [ "$VERSION" = "latest" ]; then
    DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${BINARY}"
else
    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${BINARY}"
fi

echo "==> Kin Installer"
echo "    Platform: ${OS} ${ARCH}"
echo "    Download: ${DOWNLOAD_URL}"
echo "    Install to: ${BINDIR}/kin"
echo ""

# Download
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

echo "==> Downloading..."
if command -v curl &>/dev/null; then
    curl -sfL "$DOWNLOAD_URL" -o "$TMPFILE"
elif command -v wget &>/dev/null; then
    wget -q "$DOWNLOAD_URL" -O "$TMPFILE"
else
    echo "need curl or wget"
    exit 1
fi

chmod +x "$TMPFILE"

echo "==> Installing to ${BINDIR}/kin"
if [ ! -w "$BINDIR" ]; then
    echo "    (need sudo)"
    sudo mv "$TMPFILE" "${BINDIR}/kin"
else
    mv "$TMPFILE" "${BINDIR}/kin"
fi

echo ""
echo "==> Done! Kin ${VERSION} installed at ${BINDIR}/kin"
echo ""
echo "    Quick start:"
echo "      kin serve --lan                    # local network"
echo "      kin serve --tailscale              # via Tailscale"
echo "      kin serve --relay wss://relay.kin.sh  # via Cloudflare relay"
echo ""
echo "    Docs: https://github.com/${REPO}"