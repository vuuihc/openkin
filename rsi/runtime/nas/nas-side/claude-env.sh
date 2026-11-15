# source me: point Claude Code at the NAS host magpie (port 3425) with the same aliases as the Mac.
# The magpie gateway key is mounted at /secrets/magpie.key (not in the image, not in the repo).
export PATH=/usr/local/bin:/usr/bin:/bin:$PATH
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-http://host.docker.internal:3425}"
if [ -f /secrets/magpie.key ]; then
  export ANTHROPIC_AUTH_TOKEN="$(tr -d '\n' < /secrets/magpie.key)"
fi
export ANTHROPIC_DEFAULT_SONNET_MODEL='volcengine-gw/volcengine/deepseek-v4.1-flash[1m]'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='volcengine-gw/volcengine/deepseek-v4.1-flash[1m]'
export ANTHROPIC_SMALL_FAST_MODEL='volcengine-gw/volcengine/deepseek-v4.1-flash[1m]'
export ANTHROPIC_DEFAULT_OPUS_MODEL='volcengine-gw/kimi-k3.1-pro[1m]'
export API_TIMEOUT_MS=3000000
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export DISABLE_AUTOUPDATER=1
export TZ=Asia/Singapore
