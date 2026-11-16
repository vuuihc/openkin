package detect

// InstallURL returns the official install/homepage URL for a discovery
// catalog id, or "" when unknown. UI uses this to render an "Install" CTA
// for agents that are not detected locally, across the full catalog
// (including Tier 3 presence-only ids).
func InstallURL(id string) string {
	if id == "" {
		return ""
	}
	if u, ok := installURLs[id]; ok {
		return u
	}
	return ""
}

// installURLs is hand-maintained homepage / install documentation per catalog id.
// Prefer official docs over package registries when both exist.
var installURLs = map[string]string{
	"claude-code":     "https://docs.anthropic.com/en/docs/claude-code",
	"codex":           "https://github.com/openai/codex",
	"grok":            "https://docs.x.ai/docs/guides/grok-cli",
	"gemini-cli":      "https://github.com/google-gemini/gemini-cli",
	"qwen-code":       "https://github.com/QwenLM/qwen-code",
	"aider-desk":      "https://github.com/Aider-AI/aider",
	"qoder":           "https://qoder.com",
	"opencode":        "https://opencode.ai",
	"pi":              "https://github.com/badlogic/pi-mono",
	"cursor":          "https://cursor.com",
	"windsurf":        "https://windsurf.com",
	"zed":             "https://zed.dev",
	"github-copilot":  "https://github.com/features/copilot",
	"cline":           "https://cline.bot",
	"roo":             "https://roocode.com",
	"continue":        "https://continue.dev",
	"amp":             "https://ampcode.com",
	"augment":         "https://www.augmentcode.com",
	"openclaw":        "https://github.com/openclaw/openclaw",
	"crush":           "https://github.com/charmbracelet/crush",
	"droid":           "https://www.factory.ai",
	"kimi-code-cli":   "https://www.kimi.com/code",
	"kiro-cli":        "https://kiro.dev",
	"warp":            "https://www.warp.dev",
	"tabnine-cli":     "https://www.tabnine.com",
	"replit":          "https://replit.com",
	"openhands":       "https://github.com/All-Hands-AI/OpenHands",
	"goose":           "https://block.github.io/goose",
	"forgecode":       "https://forgecode.dev",
	"iflow-cli":       "https://github.com/iflow-ai/iflow-cli",
	"mistral-vibe":    "https://github.com/mistralai/mistral-vibe",
	"neovate":         "https://neovateai.dev",
	"pochi":           "https://docs.getpochi.com",
	"command-code":    "https://commandcode.ai",
	"kilo":            "https://kilo.ai",
	"trae":            "https://www.trae.ai",
	"trae-cn":         "https://www.trae.ai",
	"antigravity":     "https://antigravity.google",
	"antigravity-cli": "https://antigravity.google",
	"codebuddy":       "https://www.codebuddy.ai",
	"qoder-cn":        "https://qoder.com",
	"rovodev":         "https://www.atlassian.com/software/rovo",
	"junie":           "https://www.jetbrains.com/junie",
	"lingma":          "https://lingma.aliyun.com",
	"zencoder":        "https://zencoder.ai",
	"mux":             "https://mux.com",
	"firebender":      "https://firebender.com",
	"deepagents":      "https://github.com/langchain-ai/deepagents",
	"kode":            "https://github.com/shareAI-lab/kode",
	"mcpjam":          "https://mcpjam.com",
	"adal":            "https://adal.com",
	"cortex":          "https://cortex.io",
	"dexto":           "https://dexto.ai",
	"eve":             "https://eve.ai",
	"hermes-agent":    "https://hermes.dev",
	"inference-sh":    "https://inference.sh",
	"jazz":            "https://jazz.tools",
	"loaf":            "https://loaf.ai",
	"moxby":           "https://moxby.com",
	"ona":             "https://ona.ai",
	"reasonix":        "https://reasonix.ai",
	"terramind":       "https://terramind.ai",
	"tinycloud":       "https://tinycloud.ai",
	"zcode":           "https://zcode.ai",
	"zenflow":         "https://zenflow.ai",
}
