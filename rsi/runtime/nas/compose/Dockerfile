FROM node:24-bookworm-slim
# Kin RSI NAS worker image: Node 24 + npm, git, Python, Claude Code CLI.
# No secrets in the image. Magpie key is mounted at /secrets/magpie.key at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates python3 curl bash tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code \
    && git config --system --add safe.directory '*'
# node image already has uid 1000 `node`, matching the NAS user (uid 1000).
USER node
WORKDIR /work
ENTRYPOINT ["tini", "--"]
CMD ["sleep", "infinity"]
