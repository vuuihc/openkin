# source me: points Claude Code at box gateway (same aliases as Mac ~/.claude/settings.json)
export PATH=$HOME/.local/bin:$PATH
export ANTHROPIC_BASE_URL=http://127.0.0.1:3425
export ANTHROPIC_AUTH_TOKEN="$(cat /workspace/box-lane/proxy.key)"
export ANTHROPIC_DEFAULT_SONNET_MODEL='volcengine-gw/volcengine/deepseek-v4.1-flash[1m]'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='volcengine-gw/volcengine/deepseek-v4.1-flash[1m]'
export ANTHROPIC_SMALL_FAST_MODEL='volcengine-gw/volcengine/deepseek-v4.1-flash[1m]'
export ANTHROPIC_DEFAULT_OPUS_MODEL='volcengine-gw/kimi-k3.1-pro[1m]'
export API_TIMEOUT_MS=3000000
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export DISABLE_AUTOUPDATER=1
