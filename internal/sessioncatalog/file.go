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
// Cursor is a decimal JSONL line number, so new pages do not duplicate data.
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
	start := 0
	if q.Cursor != "" {
		n, err := strconv.Atoi(q.Cursor)
		if err != nil || n < 0 {
			return agent.HistoryPage{}, fmt.Errorf("invalid history cursor")
		}
		start = n
	}
	limit := q.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
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
	for sc.Scan() {
		raw := []byte(sc.Bytes())
		if lineNo >= start {
			if item, ok := c.parseHistory(raw, info, sourceRev, lineNo); ok {
				items = append(items, item)
				if len(items) >= limit {
					lineNo++
					break
				}
			}
		}
		lineNo++
	}
	if err := sc.Err(); err != nil {
		return agent.HistoryPage{}, fmt.Errorf("read session history: %w", err)
	}
	next := ""
	if lineNo < countLines(path, maxLineBytes) {
		next = strconv.Itoa(lineNo)
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

func (c *FileCatalog) parseHistory(raw []byte, info agent.SessionInfo, rev string, lineNo int) (agent.HistoryItem, bool) {
	record, ok := decodeRecord(raw)
	if !ok {
		return agent.HistoryItem{}, false
	}
	role, text, id := "", "", ""
	switch c.Format {
	case FormatClaude:
		typ := stringValue(record["type"])
		if typ != "user" && typ != "assistant" {
			return agent.HistoryItem{}, false
		}
		msg, _ := record["message"].(map[string]any)
		role = stringValue(msg["role"])
		text = contentText(msg["content"])
		id = stringValue(record["uuid"])
	case FormatCodex:
		payload, _ := record["payload"].(map[string]any)
		if stringValue(payload["type"]) != "message" {
			return agent.HistoryItem{}, false
		}
		role = stringValue(payload["role"])
		text = contentText(payload["content"])
		id = stringValue(record["ordinal"])
	}
	if (role != "user" && role != "assistant") || strings.TrimSpace(text) == "" {
		return agent.HistoryItem{}, false
	}
	return agent.HistoryItem{
		AgentID:     info.AgentID,
		ExternalRef: info.ExternalRef,
		MessageID:   firstNonEmpty(id, strconv.Itoa(lineNo)),
		Role:        role,
		Text:        truncate(text, maxHistoryText),
		OccurredAt:  info.UpdatedAt,
		SourceRev:   rev,
	}, true
}

func decodeRecord(raw []byte) (map[string]any, bool) {
	var record map[string]any
	if json.Unmarshal(raw, &record) != nil {
		return nil, false
	}
	return record, true
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
				text := firstNonEmpty(stringValue(m["text"]), stringValue(m["input_text"]), stringValue(m["output_text"]))
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
