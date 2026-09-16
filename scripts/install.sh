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
    CHECKSUM_URL="https://github.com/${REPO}/releases/latest/download/SHA256SUMS"
else
    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${BINARY}"
    CHECKSUM_URL="https://github.com/${REPO}/releases/download/${VERSION}/SHA256SUMS"
fi

echo "==> Kin Installer"
echo "    Platform: ${OS} ${ARCH}"
echo "    Download: ${DOWNLOAD_URL}"
echo "    Install to: ${BINDIR}/kin"
echo ""

# Download
TMPFILE=$(mktemp)
CHECKSUMFILE=$(mktemp)
trap 'rm -f "$TMPFILE" "$CHECKSUMFILE"' EXIT

echo "==> Downloading..."
if command -v curl &>/dev/null; then
    curl -sfL "$DOWNLOAD_URL" -o "$TMPFILE"
elif command -v wget &>/dev/null; then
    wget -q "$DOWNLOAD_URL" -O "$TMPFILE"
else
    echo "need curl or wget"
    exit 1
fi

echo "==> Verifying SHA-256..."
if command -v curl &>/dev/null; then
    curl -sfL "$CHECKSUM_URL" -o "$CHECKSUMFILE"
else
    wget -q "$CHECKSUM_URL" -O "$CHECKSUMFILE"
fi
EXPECTED=$(awk -v name="$BINARY" '$2 == name || $2 == "*" name { print $1; exit }' "$CHECKSUMFILE")
if [ -z "$EXPECTED" ]; then
    echo "checksum entry for ${BINARY} is missing"
    exit 1
fi
if command -v shasum &>/dev/null; then
    ACTUAL=$(shasum -a 256 "$TMPFILE" | awk '{print $1}')
else
    ACTUAL=$(sha256sum "$TMPFILE" | awk '{print $1}')
fi
if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "checksum verification failed"
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

INSTALLED_VERSION=$("${BINDIR}/kin" version 2>/dev/null || true)
echo ""
echo "==> Done! Kin ${INSTALLED_VERSION:-$VERSION} installed at ${BINDIR}/kin"
echo ""
echo "    Quick start:"
echo "      kin serve --lan                    # local network"
echo "      kin serve --tailscale              # via Tailscale"
echo "      kin serve --relay wss://relay.kin.sh  # via Cloudflare relay"
echo ""
echo "    Docs: https://github.com/${REPO}"
