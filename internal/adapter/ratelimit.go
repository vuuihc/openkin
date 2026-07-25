package adapter

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// RateLimitInfo is a structured rate-limit / quota signal extracted from adapter
// output. It is best-effort: ResetAt may be 0 when the provider did not report one.
type RateLimitInfo struct {
	// Kind is always "rate_limited" for now (stable discriminator for UI/API).
	Kind string `json:"kind"`
	// Provider is a short id when known: "claude" | "codex" | "kin" | "".
	Provider string `json:"provider,omitempty"`
	// Agent is the agent id that hit the limit when known.
	Agent string `json:"agent,omitempty"`
	// Message is a short human-readable reason.
	Message string `json:"message"`
	// ResetAt is unix epoch seconds when the window resets; 0 if unknown.
	ResetAt int64 `json:"reset_at,omitempty"`
	// Window is an optional label such as "5h" or "weekly".
	Window string `json:"window,omitempty"`
	// Source describes where the signal came from (error|result|rate_limit_event).
	Source string `json:"source,omitempty"`
}

// RateLimitKind is the stable error kind string used in event payloads.
const RateLimitKind = "rate_limited"

var (
	// Matches phrases that almost always mean provider quota / subscription limits.
	rateLimitPhrase = regexp.MustCompile(`(?i)(` +
		`rate[_\s-]?limit(?:ed|ing)?|` +
		`hit(?:ting)?\s+(?:your\s+)?(?:usage|rate)\s+limit|` +
		`usage\s+limit(?:\s+reached)?|` +
		`quota\s+(?:exceeded|exhausted)|` +
		`too many requests|` +
		`http\s*429|` +
		`status\s*429|` +
		`out of (?:credits?|quota)|` +
		`you've hit|you have hit|` +
		`limit reached|` +
		`resets?\s+at\b|` +
		`try again (?:at|in)\b` +
		`)`)

	// Extract reset timestamps from free-form text.
	resetUnixRe     = regexp.MustCompile(`(?i)resets?[_\s-]?at["\s:=]+(\d{10,13})`)
	resetRFC3339Re  = regexp.MustCompile(`(?i)(?:resets?(?:\s+at)?|try again at)\s*[:=]?\s*(\d{4}-\d{2}-\d{2}T[0-9:.+-Z]+)`)
	resetAfterSecRe = regexp.MustCompile(`(?i)(?:retry[_\s-]?after|try again in)\s*[:=]?\s*(\d+)\s*(s|sec|secs|second|seconds)?\b`)
	resetAfterMinRe = regexp.MustCompile(`(?i)(?:retry[_\s-]?after|try again in)\s*[:=]?\s*(\d+)\s*(m|min|mins|minute|minutes)\b`)
	resetAfterHrRe  = regexp.MustCompile(`(?i)(?:retry[_\s-]?after|try again in)\s*[:=]?\s*(\d+)\s*(h|hr|hrs|hour|hours)\b`)
)

// DetectRateLimitMessage reports whether text looks like a provider rate-limit
// or quota error and extracts any reset hint it can find.
func DetectRateLimitMessage(message string) (RateLimitInfo, bool) {
	msg := strings.TrimSpace(message)
	if msg == "" {
		return RateLimitInfo{}, false
	}
	if !rateLimitPhrase.MatchString(msg) {
		return RateLimitInfo{}, false
	}
	info := RateLimitInfo{
		Kind:    RateLimitKind,
		Message: shortenRateLimitMessage(msg),
		ResetAt: ParseRateLimitReset(msg),
		Source:  "error",
	}
	return info, true
}

// DetectRateLimitPayload inspects a JSON event payload (error/result/limit_hit)
// for structured or free-text rate-limit signals.
func DetectRateLimitPayload(raw json.RawMessage) (RateLimitInfo, bool) {
	if len(raw) == 0 {
		return RateLimitInfo{}, false
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		// Fall back to treating the whole blob as text.
		return DetectRateLimitMessage(string(raw))
	}

	// Already structured.
	if kind, _ := m["kind"].(string); strings.EqualFold(strings.TrimSpace(kind), RateLimitKind) {
		info := RateLimitInfo{
			Kind:     RateLimitKind,
			Provider: stringField(m, "provider"),
			Agent:    stringField(m, "agent"),
			Message:  firstNonEmpty(stringField(m, "message"), stringField(m, "result"), "rate limited"),
			ResetAt:  int64Field(m, "reset_at", "resets_at", "resetAt", "resetsAt"),
			Window:   stringField(m, "window"),
			Source:   firstNonEmpty(stringField(m, "source"), "structured"),
		}
		if info.ResetAt == 0 {
			info.ResetAt = ParseRateLimitReset(info.Message)
		}
		return info, true
	}

	// Nested rate_limit_info (Claude Code rate_limit_event).
	if nested, ok := m["rate_limit_info"].(map[string]any); ok {
		info := RateLimitInfo{
			Kind:     RateLimitKind,
			Provider: firstNonEmpty(stringField(m, "provider"), "claude"),
			Message:  firstNonEmpty(stringField(nested, "message"), stringField(m, "message"), "rate limited"),
			ResetAt:  int64Field(nested, "resetsAt", "resets_at", "reset_at", "resetAt"),
			Window:   firstNonEmpty(stringField(nested, "window"), stringField(nested, "bucket"), stringField(nested, "type")),
			Source:   "rate_limit_event",
		}
		if status, _ := nested["status"].(string); status != "" && info.Message == "rate limited" {
			info.Message = "rate limited (" + status + ")"
		}
		if info.ResetAt > 1_000_000_000_000 { // ms → sec
			info.ResetAt = info.ResetAt / 1000
		}
		if info.ResetAt == 0 {
			info.ResetAt = ParseRateLimitReset(info.Message)
		}
		return info, true
	}

	// Free-text fields commonly present on error/result events.
	text := firstNonEmpty(
		stringField(m, "message"),
		stringField(m, "result"),
		stringField(m, "error"),
		stringField(m, "text"),
	)
	if nested, ok := m["error"].(map[string]any); ok {
		if text == "" {
			text = stringField(nested, "message")
		}
	}
	info, ok := DetectRateLimitMessage(text)
	if !ok {
		return RateLimitInfo{}, false
	}
	if v := int64Field(m, "reset_at", "resets_at", "resetAt", "resetsAt"); v > 0 {
		info.ResetAt = v
		if info.ResetAt > 1_000_000_000_000 {
			info.ResetAt = info.ResetAt / 1000
		}
	}
	if info.Provider == "" {
		info.Provider = stringField(m, "provider")
	}
	if info.Agent == "" {
		info.Agent = stringField(m, "agent")
	}
	if info.Window == "" {
		info.Window = stringField(m, "window")
	}
	return info, true
}

// ParseRateLimitReset extracts a unix-seconds reset time from free-form text.
// Returns 0 when no usable hint is present.
func ParseRateLimitReset(message string) int64 {
	msg := strings.TrimSpace(message)
	if msg == "" {
		return 0
	}
	if m := resetUnixRe.FindStringSubmatch(msg); len(m) == 2 {
		n, err := strconv.ParseInt(m[1], 10, 64)
		if err == nil {
			if n > 1_000_000_000_000 { // ms
				n = n / 1000
			}
			if n > 1_000_000_000 { // plausible unix sec
				return n
			}
		}
	}
	if m := resetRFC3339Re.FindStringSubmatch(msg); len(m) == 2 {
		if t, err := time.Parse(time.RFC3339, m[1]); err == nil {
			return t.Unix()
		}
		if t, err := time.Parse(time.RFC3339Nano, m[1]); err == nil {
			return t.Unix()
		}
	}
	now := time.Now()
	if m := resetAfterHrRe.FindStringSubmatch(msg); len(m) >= 2 {
		n, _ := strconv.Atoi(m[1])
		if n > 0 {
			return now.Add(time.Duration(n) * time.Hour).Unix()
		}
	}
	if m := resetAfterMinRe.FindStringSubmatch(msg); len(m) >= 2 {
		n, _ := strconv.Atoi(m[1])
		if n > 0 {
			return now.Add(time.Duration(n) * time.Minute).Unix()
		}
	}
	if m := resetAfterSecRe.FindStringSubmatch(msg); len(m) >= 2 {
		n, _ := strconv.Atoi(m[1])
		if n > 0 {
			return now.Add(time.Duration(n) * time.Second).Unix()
		}
	}
	return 0
}

// EnrichErrorPayload adds kind=rate_limited (and reset_at when known) to an
// error/result payload map when the message looks like a rate limit. Returns
// the original map unchanged when it does not match.
func EnrichErrorPayload(payload map[string]any) map[string]any {
	if payload == nil {
		return payload
	}
	if kind, _ := payload["kind"].(string); strings.EqualFold(strings.TrimSpace(kind), RateLimitKind) {
		return payload
	}
	text := firstNonEmpty(
		stringField(payload, "message"),
		stringField(payload, "result"),
	)
	info, ok := DetectRateLimitMessage(text)
	if !ok {
		return payload
	}
	payload["kind"] = RateLimitKind
	if info.ResetAt > 0 {
		payload["reset_at"] = info.ResetAt
	}
	if _, exists := payload["message"]; !exists || strings.TrimSpace(stringField(payload, "message")) == "" {
		payload["message"] = info.Message
	}
	return payload
}

func shortenRateLimitMessage(msg string) string {
	msg = strings.TrimSpace(msg)
	// Keep one line, cap length for chat noise control.
	if i := strings.IndexByte(msg, '\n'); i >= 0 {
		msg = msg[:i]
	}
	msg = strings.TrimSpace(msg)
	if len(msg) > 240 {
		// Avoid cutting mid-rune.
		r := []rune(msg)
		if len(r) > 240 {
			msg = string(r[:240]) + "…"
		}
	}
	return msg
}

func stringField(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			switch t := v.(type) {
			case string:
				if s := strings.TrimSpace(t); s != "" {
					return s
				}
			}
		}
	}
	return ""
}

func int64Field(m map[string]any, keys ...string) int64 {
	for _, k := range keys {
		v, ok := m[k]
		if !ok || v == nil {
			continue
		}
		switch t := v.(type) {
		case float64:
			n := int64(t)
			if n > 1_000_000_000_000 {
				n = n / 1000
			}
			if n > 0 {
				return n
			}
		case int64:
			n := t
			if n > 1_000_000_000_000 {
				n = n / 1000
			}
			if n > 0 {
				return n
			}
		case int:
			if t > 0 {
				return int64(t)
			}
		case json.Number:
			if n, err := t.Int64(); err == nil && n > 0 {
				if n > 1_000_000_000_000 {
					n = n / 1000
				}
				return n
			}
		case string:
			if n, err := strconv.ParseInt(strings.TrimSpace(t), 10, 64); err == nil && n > 0 {
				if n > 1_000_000_000_000 {
					n = n / 1000
				}
				return n
			}
		}
	}
	return 0
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}
