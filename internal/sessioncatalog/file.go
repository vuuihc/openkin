// Package sessioncatalog reads provider-owned JSONL session stores without
// copying their transcript into Kin's database.
package sessioncatalog

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/vuuihc/openkin/internal/agent"
)

const (
	FormatCodex  = "codex"
	FormatClaude = "claude"

	defaultMaxFiles     = 500
	defaultMaxFileBytes = 128 << 20
	maxLineBytes        = 8 << 20
	maxHistoryText      = 64 << 10
	maxTitleRunes       = 160
)

// FileCatalog is a bounded JSONL provider session catalog.
type FileCatalog struct {
	AgentID      string
	Format       string
	Roots        []string
	MaxFiles     int
	MaxFileBytes int64
}

type fileSession struct {
	info agent.SessionInfo
	path string
}

// List discovers provider sessions beneath configured local roots.
func (c *FileCatalog) List(ctx context.Context, q agent.SessionQuery) ([]agent.SessionInfo, error) {
	sessions, err := c.scan(ctx)
	if err != nil {
		return nil, err
	}
	query := strings.ToLower(strings.TrimSpace(q.Query))
	cwd := filepath.Clean(strings.TrimSpace(q.Cwd))
	filtered := make([]agent.SessionInfo, 0, len(sessions))
	for _, item := range sessions {
		if query != "" &&
			!strings.Contains(strings.ToLower(item.info.Title), query) &&
			!strings.Contains(strings.ToLower(item.info.Cwd), query) &&
			!strings.Contains(strings.ToLower(item.info.ExternalRef), query) {
			continue
		}
		if cwd != "." && cwd != "" && item.info.Cwd != cwd {
			continue
		}
		filtered = append(filtered, item.info)
	}
	limit := q.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	start := 0
	if q.Cursor != "" {
		n, err := strconv.Atoi(q.Cursor)
		if err != nil || n < 0 {
			return nil, fmt.Errorf("invalid session cursor")
		}
		start = n
	}
	if start >= len(filtered) {
		return []agent.SessionInfo{}, nil
	}
	end := start + limit
	if end > len(filtered) {
		end = len(filtered)
	}
	return filtered[start:end], nil
}

// Inspect loads one provider session's bounded metadata.
func (c *FileCatalog) Inspect(ctx context.Context, externalRef string) (agent.SessionInfo, error) {
	sessions, err := c.scan(ctx)
	if err != nil {
		return agent.SessionInfo{}, err
	}
	for _, item := range sessions {
		if item.info.ExternalRef == externalRef {
			return item.info, nil
		}
	}
	return agent.SessionInfo{}, os.ErrNotExist
}

// ReadHistory reads normalized message items directly from the source file.
// Cursor is a JSONL line number, optionally followed by a content-block offset.
func (c *FileCatalog) ReadHistory(ctx context.Context, externalRef string, q agent.HistoryQuery) (agent.HistoryPage, error) {
	info, err := c.Inspect(ctx, externalRef)
	if err != nil {
		return agent.HistoryPage{}, err
	}
	path := strings.TrimPrefix(info.SourceURI, "file://")
	st, err := os.Stat(path)
	if err != nil {
		return agent.HistoryPage{}, fmt.Errorf("stat session source: %w", err)
	}
	sourceRev := sourceRevision(st)
	limit := q.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}
	startLine, startBlock, err := parseHistoryCursor(q.Cursor, sourceRev)
	if err != nil {
		return agent.HistoryPage{}, err
	}
	f, err := os.Open(path)
	if err != nil {
		return agent.HistoryPage{}, fmt.Errorf("open session source: %w", err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), maxLineBytes)
	lineNo := 0
	items := make([]agent.HistoryItem, 0, limit)
	next := ""
	for sc.Scan() {
		raw := []byte(sc.Bytes())
		if lineNo < startLine {
			lineNo++
			continue
		}
		parsed := c.parseHistoryItems(raw, info, sourceRev, lineNo)
		if lineNo == startLine && startBlock > 0 {
			if startBlock >= len(parsed) {
				lineNo++
				continue
			}
			parsed = parsed[startBlock:]
		}
		if len(parsed) == 0 {
			lineNo++
			continue
		}
		remaining := limit - len(items)
		if len(parsed) > remaining {
			items = append(items, parsed[:remaining]...)
			next = encodeHistoryCursor(sourceRev, lineNo, startBlock+remaining)
			break
		}
		items = append(items, parsed...)
		startBlock = 0
		if len(items) >= limit {
			lineNo++
			break
		}
		lineNo++
	}
	if err := sc.Err(); err != nil {
		return agent.HistoryPage{}, fmt.Errorf("read session history: %w", err)
	}
	if next == "" && lineNo < countLines(path, maxLineBytes) {
		next = encodeHistoryCursor(sourceRev, lineNo, 0)
	}
	return agent.HistoryPage{Items: items, NextCursor: next, SourceRev: sourceRev}, nil
}

func (c *FileCatalog) scan(ctx context.Context) ([]fileSession, error) {
	maxFiles := c.MaxFiles
	if maxFiles <= 0 {
		maxFiles = defaultMaxFiles
	}
	maxBytes := c.MaxFileBytes
	if maxBytes <= 0 {
		maxBytes = defaultMaxFileBytes
	}
	out := make([]fileSession, 0)
	seen := make(map[string]bool)
	for _, root := range c.Roots {
		root = filepath.Clean(strings.TrimSpace(root))
		if root == "" {
			continue
		}
		err := filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
			if walkErr != nil {
				if os.IsPermission(walkErr) {
					return nil
				}
				return walkErr
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			default:
			}
			if d.IsDir() {
				if d.Name() == "subagents" || d.Name() == "tool-results" {
					return filepath.SkipDir
				}
				return nil
			}
			if len(out) >= maxFiles || filepath.Ext(path) != ".jsonl" {
				return nil
			}
			if d.Type()&os.ModeSymlink != 0 || seen[path] {
				return nil
			}
			seen[path] = true
			info, err := c.summarize(ctx, path, maxBytes)
			if err != nil || info.ExternalRef == "" {
				return nil
			}
			out = append(out, fileSession{info: info, path: path})
			return nil
		})
		if err != nil && err != context.Canceled && err != context.DeadlineExceeded {
			return nil, fmt.Errorf("scan session root %q: %w", root, err)
		}
		if len(out) >= maxFiles {
			break
		}
	}
	return out, nil
}

func (c *FileCatalog) summarize(ctx context.Context, path string, maxBytes int64) (agent.SessionInfo, error) {
	st, err := os.Stat(path)
	if err != nil || st.Size() > maxBytes {
		if err == nil {
			err = fmt.Errorf("source exceeds %d bytes", maxBytes)
		}
		return agent.SessionInfo{}, err
	}
	f, err := os.Open(path)
	if err != nil {
		return agent.SessionInfo{}, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), maxLineBytes)
	var info agent.SessionInfo
	info.AgentID = c.AgentID
	info.SourceURI = "file://" + path
	info.SourceCursor = sourceRevision(st)
	info.Status = "idle"
	for i := 0; i < 4096 && sc.Scan(); i++ {
		select {
		case <-ctx.Done():
			return agent.SessionInfo{}, ctx.Err()
		default:
		}
		c.applySummaryRecord(&info, sc.Bytes())
	}
	if err := sc.Err(); err != nil {
		return agent.SessionInfo{}, err
	}
	if info.ExternalRef == "" {
		return agent.SessionInfo{}, os.ErrNotExist
	}
	if info.Title == "" {
		info.Title = info.ExternalRef
	}
	info.Title = boundedTitle(info.Title, info.ExternalRef)
	info.UpdatedAt = st.ModTime()
	info.CreatedAt = st.ModTime()
	info.Capabilities = []agent.Capability{
		agent.CapabilitySessionList,
		agent.CapabilitySessionInspect,
		agent.CapabilitySessionHistoryRead,
		agent.CapabilitySessionAttach,
	}
	return info, nil
}

func (c *FileCatalog) applySummaryRecord(info *agent.SessionInfo, raw []byte) {
	record, ok := decodeRecord(raw)
	if !ok {
		return
	}
	switch c.Format {
	case FormatClaude:
		if ref := stringValue(record["sessionId"]); ref != "" {
			info.ExternalRef = ref
		}
		if cwd := stringValue(record["cwd"]); cwd != "" {
			info.Cwd = filepath.Clean(cwd)
		}
		if title := firstNonEmpty(
			stringValue(record["customTitle"]),
			stringValue(record["summary"]),
			stringValue(record["title"]),
		); title != "" && info.Title == "" {
			info.Title = title
		}
	case FormatCodex:
		payload, _ := record["payload"].(map[string]any)
		if ref := stringValue(payload["session_id"]); ref != "" {
			info.ExternalRef = ref
		}
		if cwd := stringValue(payload["cwd"]); cwd != "" {
			info.Cwd = filepath.Clean(cwd)
		}
		if title := firstNonEmpty(
			stringValue(payload["title"]),
			stringValue(payload["session_title"]),
			stringValue(payload["summary"]),
		); title != "" && info.Title == "" {
			info.Title = title
		}
	}
}

func (c *FileCatalog) parseHistoryItems(raw []byte, info agent.SessionInfo, rev string, lineNo int) []agent.HistoryItem {
	record, ok := decodeRecord(raw)
	if !ok {
		return nil
	}
	switch c.Format {
	case FormatClaude:
		return parseClaudeHistoryItems(record, info, rev, lineNo)
	case FormatCodex:
		return parseCodexHistoryItems(record, info, rev, lineNo)
	default:
		return nil
	}
}

func parseCodexHistoryItems(record map[string]any, info agent.SessionInfo, rev string, lineNo int) []agent.HistoryItem {
	payload, _ := record["payload"].(map[string]any)
	id := firstNonEmpty(stringValue(payload["call_id"]), stringValue(record["ordinal"]))
	var item agent.HistoryItem
	switch stringValue(payload["type"]) {
	case "message":
		role := stringValue(payload["role"])
		if role != "user" && role != "assistant" {
			return nil
		}
		item = historyItem(
			info,
			rev,
			firstNonEmpty(id, strconv.Itoa(lineNo)),
			"message",
			role,
			"",
			contentText(payload["content"]),
		)
	case "function_call":
		toolName := firstNonEmpty(stringValue(payload["name"]), "tool")
		text := "调用工具: " + toolName
		if arguments := safeToolSummary(payload["arguments"]); arguments != "" {
			text += "\n" + arguments
		}
		item = historyItem(
			info,
			rev,
			firstNonEmpty(id, strconv.Itoa(lineNo)),
			"tool_call",
			"tool",
			toolName,
			text,
		)
	case "function_call_output":
		text := "工具结果"
		if output := safeToolSummary(payload["output"]); output != "" {
			text += "\n" + output
		}
		item = historyItem(
			info,
			rev,
			firstNonEmpty(id, strconv.Itoa(lineNo)),
			"tool_result",
			"tool",
			"",
			text,
		)
	case "reasoning":
		text := firstNonEmpty(
			contentText(payload["summary"]),
			contentText(payload["content"]),
			jsonSummary(payload["summary"]),
			jsonSummary(payload["content"]),
		)
		item = historyItem(
			info,
			rev,
			firstNonEmpty(id, strconv.Itoa(lineNo)),
			"reasoning",
			"assistant",
			"",
			text,
		)
	default:
		return nil
	}
	if strings.TrimSpace(item.Text) == "" {
		return nil
	}
	return []agent.HistoryItem{item}
}

func parseClaudeHistoryItems(record map[string]any, info agent.SessionInfo, rev string, lineNo int) []agent.HistoryItem {
	typ := stringValue(record["type"])
	if typ != "user" && typ != "assistant" {
		return nil
	}
	msg, _ := record["message"].(map[string]any)
	role := stringValue(msg["role"])
	if role != "user" && role != "assistant" {
		return nil
	}
	id := firstNonEmpty(stringValue(record["uuid"]), strconv.Itoa(lineNo))
	content, ok := msg["content"].([]any)
	if !ok {
		item := historyItem(info, rev, id, "message", role, "", contentText(msg["content"]))
		if strings.TrimSpace(item.Text) == "" {
			return nil
		}
		return []agent.HistoryItem{item}
	}
	items := make([]agent.HistoryItem, 0, len(content))
	for index, rawBlock := range content {
		block, ok := rawBlock.(map[string]any)
		if !ok {
			continue
		}
		blockID := firstNonEmpty(
			stringValue(block["id"]),
			stringValue(block["tool_use_id"]),
			fmt.Sprintf("%s:%d", id, index),
		)
		switch stringValue(block["type"]) {
		case "text":
			items = appendClaudeHistoryItem(items, historyItem(
				info,
				rev,
				blockID,
				"message",
				role,
				"",
				stringValue(block["text"]),
			))
		case "thinking":
			items = appendClaudeHistoryItem(items, historyItem(
				info,
				rev,
				blockID,
				"reasoning",
				"assistant",
				"",
				stringValue(block["thinking"]),
			))
		case "tool_use":
			toolName := firstNonEmpty(stringValue(block["name"]), "tool")
			text := "调用工具: " + toolName
			if input := safeToolSummary(block["input"]); input != "" {
				text += "\n" + input
			}
			items = appendClaudeHistoryItem(items, historyItem(
				info,
				rev,
				blockID,
				"tool_call",
				"tool",
				toolName,
				text,
			))
		case "tool_result":
			text := "工具结果"
			if output := safeToolSummary(block["content"]); output != "" {
				text += "\n" + output
			}
			items = appendClaudeHistoryItem(items, historyItem(
				info,
				rev,
				blockID,
				"tool_result",
				"tool",
				"",
				text,
			))
		}
	}
	return items
}

func appendClaudeHistoryItem(items []agent.HistoryItem, item agent.HistoryItem) []agent.HistoryItem {
	if strings.TrimSpace(item.Text) == "" {
		return items
	}
	return append(items, item)
}

func historyItem(
	info agent.SessionInfo,
	rev string,
	id string,
	kind string,
	role string,
	toolName string,
	text string,
) agent.HistoryItem {
	return agent.HistoryItem{
		AgentID:     info.AgentID,
		ExternalRef: info.ExternalRef,
		MessageID:   id,
		Kind:        kind,
		Role:        role,
		ToolName:    toolName,
		Text:        truncate(text, maxHistoryText),
		OccurredAt:  info.UpdatedAt,
		SourceRev:   rev,
	}
}

func decodeRecord(raw []byte) (map[string]any, bool) {
	var record map[string]any
	if json.Unmarshal(raw, &record) != nil {
		return nil, false
	}
	return record, true
}

func parseHistoryCursor(cursor, sourceRev string) (line, block int, err error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return 0, 0, nil
	}
	if parts := strings.SplitN(cursor, "|", 2); len(parts) == 2 {
		if parts[0] != sourceRev {
			return 0, 0, fmt.Errorf("stale history cursor")
		}
		cursor = parts[1]
	}
	parts := strings.Split(cursor, ":")
	if len(parts) > 2 {
		return 0, 0, fmt.Errorf("invalid history cursor")
	}
	line, err = strconv.Atoi(parts[0])
	if err != nil || line < 0 {
		return 0, 0, fmt.Errorf("invalid history cursor")
	}
	if len(parts) == 2 {
		block, err = strconv.Atoi(parts[1])
		if err != nil || block < 0 {
			return 0, 0, fmt.Errorf("invalid history cursor")
		}
	}
	return line, block, nil
}

func encodeHistoryCursor(sourceRev string, line, block int) string {
	position := strconv.Itoa(line)
	if block <= 0 {
		return sourceRev + "|" + position
	}
	return sourceRev + "|" + fmt.Sprintf("%s:%d", position, block)
}

func recordText(record map[string]any, role string) string {
	msg, _ := record["message"].(map[string]any)
	if stringValue(msg["role"]) != role {
		return ""
	}
	return contentText(msg["content"])
}

func payloadText(payload map[string]any, role string) string {
	if stringValue(payload["type"]) != "message" || stringValue(payload["role"]) != role {
		return ""
	}
	return contentText(payload["content"])
}

func contentText(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case []any:
		var parts []string
		for _, item := range v {
			if m, ok := item.(map[string]any); ok {
				kind := stringValue(m["type"])
				text := firstNonEmpty(
					stringValue(m["text"]),
					stringValue(m["input_text"]),
					stringValue(m["output_text"]),
				)
				switch kind {
				case "tool_use":
					text = "调用工具: " + firstNonEmpty(stringValue(m["name"]), "tool")
					if input := safeToolSummary(m["input"]); input != "" {
						text += "\n" + input
					}
				case "tool_result":
					text = "工具结果"
					if output := safeToolSummary(m["content"]); output != "" {
						text += "\n" + output
					}
				}
				if text != "" {
					parts = append(parts, text)
				}
			}
		}
		return strings.Join(parts, "\n")
	default:
		return ""
	}
}

func jsonSummary(value any) string {
	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v)
	case nil:
		return ""
	default:
		raw, err := json.Marshal(v)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(raw))
	}
}

const maxToolSummaryRunes = 12 << 10

var credentialAssignmentPattern = regexp.MustCompile(
	"(?i)([A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key|credential|authorization|private[_-]?key|cookie)[A-Za-z0-9_-]*\\s*[:=]\\s*)([^\\s\"'`]+)",
)
var credentialQuotedAssignmentPattern = regexp.MustCompile(
	"(?i)([A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key|credential|authorization|private[_-]?key|cookie)[A-Za-z0-9_-]*\\s*[:=]\\s*)([\"'])[^\"']*([\"'])",
)

func safeToolSummary(value any) string {
	if text, ok := value.(string); ok {
		var decoded any
		if json.Unmarshal([]byte(text), &decoded) == nil {
			value = decoded
		} else {
			return truncate(redactText(text), maxToolSummaryRunes)
		}
	}
	return truncate(jsonSummary(redactToolValue(value)), maxToolSummaryRunes)
}

func redactToolValue(value any) any {
	switch v := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			if sensitiveToolKey(key) {
				out[key] = "[redacted]"
				continue
			}
			out[key] = redactToolValue(item)
		}
		return out
	case []any:
		out := make([]any, len(v))
		redactNext := false
		for i, item := range v {
			if redactNext {
				out[i] = "[redacted]"
				redactNext = false
				continue
			}
			if flag, ok := item.(string); ok && sensitiveToolFlag(flag) {
				out[i] = flag
				redactNext = true
				continue
			}
			out[i] = redactToolValue(item)
		}
		return out
	case string:
		return redactText(v)
	default:
		return value
	}
}

func sensitiveToolKey(key string) bool {
	key = strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			return r
		}
		return -1
	}, strings.ToLower(key))
	for _, marker := range []string{
		"token", "secret", "password", "apikey", "authorization",
		"privatekey", "cookie", "accesskey", "credential", "clientsecret",
	} {
		if strings.Contains(key, marker) {
			return true
		}
	}
	return false
}

func redactText(value string) string {
	for _, marker := range []string{
		"Bearer ", "sk-", "ghp_", "xoxb-",
		"--token ", "--api-key ", "--apikey ", "--access-key ",
		"--access_key ", "--secret ", "--password ",
		"--token=", "--api-key=", "--apikey=", "--access-key=",
		"--access_key=", "--secret=", "--password=",
	} {
		value = redactCredentialMarker(value, marker)
	}
	value = credentialQuotedAssignmentPattern.ReplaceAllString(value, "${1}${2}[redacted]${3}")
	value = credentialAssignmentPattern.ReplaceAllString(value, "${1}[redacted]")
	return value
}

func sensitiveToolFlag(value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	switch value {
	case "--token", "--api-key", "--apikey", "--access-key", "--access_key", "--secret", "--password":
		return true
	default:
		return false
	}
}

func redactCredentialMarker(value, marker string) string {
	index := strings.Index(value, marker)
	if index < 0 {
		return value
	}
	end := index + len(marker)
	if end < len(value) && (value[end] == '"' || value[end] == '\'') {
		quote := value[end]
		end++
		for end < len(value) && value[end] != quote {
			end++
		}
		if end < len(value) {
			end++
		}
		return value[:index] + marker + "[redacted]" + redactCredentialMarker(value[end:], marker)
	}
	for end < len(value) && !strings.ContainsRune(" \t\r\n\"'`", rune(value[end])) {
		end++
	}
	return value[:index] + marker + "[redacted]" + redactCredentialMarker(value[end:], marker)
}

func stringValue(value any) string {
	s, _ := value.(string)
	return s
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func truncate(value string, max int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	if max <= 1 {
		return string(runes[:max])
	}
	return string(runes[:max-1]) + "…"
}

func boundedTitle(value, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		value = strings.TrimSpace(fallback)
	}
	runes := []rune(value)
	if len(runes) > maxTitleRunes {
		runes = runes[:maxTitleRunes-1]
		return string(runes) + "…"
	}
	return string(runes)
}

func sourceRevision(info os.FileInfo) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%d:%d", info.Size(), info.ModTime().UnixNano())))
	return hex.EncodeToString(sum[:8])
}

func countLines(path string, maxLineBytes int) int {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), maxLineBytes)
	n := 0
	for sc.Scan() {
		n++
	}
	return n
}
