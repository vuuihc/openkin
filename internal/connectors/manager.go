package connectors

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/vuuihc/openkin/internal/secret"
)

const (
	defaultTimeout = 30 * time.Second
	defaultOutput  = 256 * 1024
)

type Manager struct {
	secrets secret.Store
	audit   AuditSink
	client  *http.Client
	mu      sync.RWMutex
	configs map[string]Config
}

func NewManager(secrets secret.Store, audit AuditSink) *Manager {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = safeDialContext
	transport.Proxy = nil
	return &Manager{
		secrets: secrets,
		audit:   audit,
		client:  &http.Client{Transport: transport},
		configs: make(map[string]Config),
	}
}

func (m *Manager) Register(cfg Config) error {
	if err := ValidateConfig(cfg); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.configs[cfg.ID]; exists {
		return fmt.Errorf("%w: connector %q already exists", ErrInvalidConfig, cfg.ID)
	}
	m.configs[cfg.ID] = cloneConfig(cfg)
	return nil
}

func (m *Manager) Update(cfg Config) error {
	if err := ValidateConfig(cfg); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.configs[cfg.ID]; !exists {
		return fmt.Errorf("%w: connector %q does not exist", ErrInvalidConfig, cfg.ID)
	}
	m.configs[cfg.ID] = cloneConfig(cfg)
	return nil
}

func (m *Manager) Disable(id string, disabled bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cfg, ok := m.configs[id]
	if !ok {
		return fmt.Errorf("%w: connector %q does not exist", ErrInvalidConfig, id)
	}
	cfg.Disabled = disabled
	m.configs[id] = cfg
	return nil
}

func (m *Manager) List() []Config {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Config, 0, len(m.configs))
	for _, cfg := range m.configs {
		out = append(out, cloneConfig(cfg))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (m *Manager) SetCredential(ref, value string) error {
	if m.secrets == nil {
		return fmt.Errorf("connector secret store is unavailable")
	}
	return m.secrets.Put(ref, value)
}

func (m *Manager) DeleteCredential(ref string) error {
	if m.secrets == nil {
		return fmt.Errorf("connector secret store is unavailable")
	}
	return m.secrets.Delete(ref)
}

func (m *Manager) Tools(ctx context.Context, id string) ([]Tool, error) {
	cfg, err := m.config(id)
	if err != nil {
		return nil, sanitizeConnectorError(err)
	}
	if cfg.Disabled {
		return nil, ErrDisabled
	}
	runCtx, cancel := context.WithTimeout(ctx, connectorTimeout(cfg))
	defer cancel()
	tools, err := m.callToolsList(runCtx, cfg)
	if err != nil {
		return nil, sanitizeConnectorError(err)
	}
	return tools, nil
}

func (m *Manager) Call(ctx context.Context, call Call) (Result, error) {
	start := time.Now()
	cfg, err := m.config(call.ConnectorID)
	if err == nil && cfg.Disabled {
		err = ErrDisabled
	}
	if err == nil && !allowed(cfg.AllowTools, call.Tool) {
		err = fmt.Errorf("%w: %s.%s", ErrToolDenied, call.ConnectorID, call.Tool)
	}
	if err != nil {
		safeErr := sanitizeConnectorError(err)
		if auditErr := m.auditCall(ctx, call, start, safeErr); auditErr != nil {
			safeErr = errors.Join(safeErr, errors.New("connector audit failed"))
		}
		return Result{}, safeErr
	}
	timeout := defaultTimeout
	if cfg.TimeoutMS > 0 {
		timeout = time.Duration(cfg.TimeoutMS) * time.Millisecond
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var result Result
	switch cfg.Kind {
	case KindStdio:
		result, err = callStdio(runCtx, cfg, call.Tool, call.Arguments, outputLimit(cfg))
	case KindHTTP:
		result, err = m.callHTTP(runCtx, cfg, call.Tool, call.Arguments, outputLimit(cfg))
	default:
		err = fmt.Errorf("%w: unknown connector kind %q", ErrInvalidConfig, cfg.Kind)
	}
	safeErr := sanitizeConnectorError(err)
	auditErr := safeErr
	if auditErr == nil && result.IsError {
		auditErr = errors.New("connector tool returned an error result")
	}
	result.LatencyMS = time.Since(start).Milliseconds()
	if persistErr := m.auditCall(ctx, call, start, auditErr); persistErr != nil {
		auditFailure := errors.New("connector audit failed")
		if safeErr == nil {
			return result, auditFailure
		}
		safeErr = errors.Join(safeErr, auditFailure)
	}
	return result, safeErr
}

func (m *Manager) config(id string) (Config, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	cfg, ok := m.configs[id]
	if !ok {
		return Config{}, fmt.Errorf("%w: connector %q does not exist", ErrInvalidConfig, id)
	}
	return cloneConfig(cfg), nil
}

func (m *Manager) callToolsList(ctx context.Context, cfg Config) ([]Tool, error) {
	var raw json.RawMessage
	var err error
	switch cfg.Kind {
	case KindStdio:
		raw, err = stdioRequest(ctx, cfg, "tools/list", nil, outputLimit(cfg))
	case KindHTTP:
		raw, err = m.httpRequest(ctx, cfg, "tools/list", nil, outputLimit(cfg))
	default:
		err = fmt.Errorf("%w: unknown connector kind %q", ErrInvalidConfig, cfg.Kind)
	}
	if err != nil {
		return nil, err
	}
	var envelope struct {
		Tools []Tool `json:"tools"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, fmt.Errorf("decode connector tools: %w", err)
	}
	filtered := make([]Tool, 0, len(envelope.Tools))
	for _, tool := range envelope.Tools {
		if allowed(cfg.AllowTools, tool.Name) {
			filtered = append(filtered, tool)
		}
	}
	return filtered, nil
}

func (m *Manager) callHTTP(ctx context.Context, cfg Config, tool string, args map[string]any, max int64) (Result, error) {
	raw, err := m.httpRequest(ctx, cfg, "tools/call", map[string]any{
		"name": tool, "arguments": args,
	}, max)
	if err != nil {
		return Result{}, err
	}
	return decodeResult(raw)
}

func (m *Manager) httpRequest(ctx context.Context, cfg Config, method string, params any, max int64) (json.RawMessage, error) {
	if err := validateURL(cfg.URL, cfg.AllowDomains); err != nil {
		return nil, err
	}
	initID := time.Now().UnixNano()
	initRaw, sessionID, protocolVersion, err := m.httpRoundTrip(ctx, cfg, initID, "initialize", map[string]any{
		"protocolVersion": mcpProtocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo": map[string]any{
			"name":    "openkin",
			"version": "dev",
		},
	}, "", mcpProtocolVersion, max, true)
	if err != nil {
		return nil, err
	}
	if _, err := decodeRPCResponse(initRaw, initID); err != nil {
		return nil, err
	}
	if protocolVersion == "" {
		protocolVersion = mcpProtocolVersion
	}
	if err := m.httpNotification(ctx, cfg, sessionID, protocolVersion, max); err != nil {
		return nil, err
	}
	id := initID + 1
	raw, _, _, err := m.httpRoundTrip(ctx, cfg, id, method, params, sessionID, protocolVersion, max, true)
	if err != nil {
		return nil, err
	}
	return decodeRPCResponse(raw, id)
}

func (m *Manager) httpNotification(ctx context.Context, cfg Config, sessionID, protocolVersion string, max int64) error {
	_, _, _, err := m.httpRoundTrip(ctx, cfg, 0, "notifications/initialized", nil, sessionID, protocolVersion, max, false)
	return err
}

func (m *Manager) httpRoundTrip(
	ctx context.Context,
	cfg Config,
	id int64,
	method string,
	params any,
	sessionID string,
	protocolVersion string,
	max int64,
	expectResponse bool,
) (json.RawMessage, string, string, error) {
	body := map[string]any{"jsonrpc": "2.0", "method": method}
	if expectResponse {
		body["id"] = id
	}
	if params != nil {
		body["params"] = params
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, "", "", fmt.Errorf("encode connector HTTP request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.URL, bytes.NewReader(data))
	if err != nil {
		return nil, "", "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Mcp-Method", method)
	if protocolVersion != "" {
		req.Header.Set("MCP-Protocol-Version", protocolVersion)
	}
	if sessionID != "" {
		req.Header.Set("MCP-Session-Id", sessionID)
	}
	if cfg.CredentialRef != "" {
		if m.secrets == nil {
			return nil, "", "", errors.New("connector secret store is unavailable")
		}
		token, secretErr := m.secrets.Get(cfg.CredentialRef)
		if secretErr != nil {
			return nil, "", "", fmt.Errorf("read connector credential: %w", secretErr)
		}
		if token == "" {
			return nil, "", "", errors.New("connector credential is empty")
		}
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := *m.client
	client.CheckRedirect = func(next *http.Request, _ []*http.Request) error {
		return validateURL(next.URL.String(), cfg.AllowDomains)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", "", fmt.Errorf("connector HTTP request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", "", fmt.Errorf("connector HTTP status %d", resp.StatusCode)
	}
	nextSession := strings.TrimSpace(resp.Header.Get("MCP-Session-Id"))
	nextVersion := strings.TrimSpace(resp.Header.Get("MCP-Protocol-Version"))
	if !expectResponse {
		data, readErr := io.ReadAll(io.LimitReader(resp.Body, max+1))
		if readErr != nil {
			return nil, "", "", fmt.Errorf("read connector notification response: %w", readErr)
		}
		if int64(len(data)) > max {
			return nil, "", "", ErrOutputTooLarge
		}
		return nil, nextSession, nextVersion, nil
	}
	raw, err := readJSONRPCResponse(resp, max, id)
	if err != nil {
		return nil, "", "", err
	}
	return raw, nextSession, nextVersion, nil
}

func decodeRPCResponse(raw json.RawMessage, expectedID int64) (json.RawMessage, error) {
	var response rpcResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		return nil, fmt.Errorf("decode connector response: %w", err)
	}
	if response.JSONRPC != "2.0" {
		return nil, errors.New("decode connector response: invalid JSON-RPC version")
	}
	var id int64
	if err := json.Unmarshal(response.ID, &id); err != nil || id != expectedID {
		return nil, errors.New("decode connector response: unexpected id")
	}
	if response.Error != nil {
		return nil, fmt.Errorf("MCP remote error %d", response.Error.Code)
	}
	if len(response.Result) == 0 || string(response.Result) == "null" {
		return nil, errors.New("connector response has no result")
	}
	return append(json.RawMessage(nil), response.Result...), nil
}

func (m *Manager) auditCall(ctx context.Context, call Call, start time.Time, err error) error {
	if m.audit == nil {
		return nil
	}
	decision := "allowlist"
	switch {
	case errors.Is(err, ErrToolDenied):
		decision = "denied"
	case errors.Is(err, ErrDisabled):
		decision = "disabled"
	case err != nil:
		decision = "rejected"
	}
	auditCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	return m.audit.RecordConnectorAudit(auditCtx, Audit{
		ConnectorID:      call.ConnectorID,
		TaskID:           call.TaskID,
		Principal:        call.Principal,
		Tool:             call.Tool,
		ArgumentsHash:    hashArguments(call.Arguments),
		ApprovalDecision: decision,
		Success:          err == nil,
		LatencyMS:        time.Since(start).Milliseconds(),
		Error:            safeError(err),
	})
}

func ValidateConfig(cfg Config) error {
	if cfg.ID == "" || strings.ContainsAny(cfg.ID, "/\\ ") {
		return fmt.Errorf("%w: connector id is invalid", ErrInvalidConfig)
	}
	if cfg.Kind != KindStdio && cfg.Kind != KindHTTP {
		return fmt.Errorf("%w: kind must be %s or %s", ErrInvalidConfig, KindStdio, KindHTTP)
	}
	if cfg.Kind == KindStdio {
		if cfg.Command == "" {
			return fmt.Errorf("%w: stdio command is required", ErrInvalidConfig)
		}
		if strings.ContainsRune(cfg.Command, 0) {
			return fmt.Errorf("%w: command contains NUL", ErrInvalidConfig)
		}
		if _, err := exec.LookPath(cfg.Command); err != nil {
			return fmt.Errorf("%w: command unavailable: %w", ErrInvalidConfig, err)
		}
	} else if err := validateURL(cfg.URL, cfg.AllowDomains); err != nil {
		return err
	}
	if cfg.TimeoutMS < 0 || cfg.MaxOutput < 0 {
		return fmt.Errorf("%w: timeout/output bounds must be non-negative", ErrInvalidConfig)
	}
	return nil
}

func validateURL(raw string, allowDomains []string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
		return ErrUnsafeURL
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if net.ParseIP(host) != nil || host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return ErrUnsafeURL
	}
	if len(allowDomains) == 0 {
		return fmt.Errorf("%w: remote connector requires an allowlist", ErrUnsafeURL)
	}
	for _, allowed := range allowDomains {
		allowed = strings.ToLower(strings.TrimSpace(strings.TrimSuffix(allowed, ".")))
		if host == allowed || strings.HasSuffix(host, "."+allowed) {
			return nil
		}
	}
	return ErrUnsafeURL
}

func allowed(list []string, value string) bool {
	if len(list) == 0 {
		return false
	}
	for _, item := range list {
		if item == "*" || item == value {
			return true
		}
	}
	return false
}

func outputLimit(cfg Config) int64 {
	if cfg.MaxOutput <= 0 || int64(cfg.MaxOutput) > defaultOutput {
		return defaultOutput
	}
	return int64(cfg.MaxOutput)
}

func connectorTimeout(cfg Config) time.Duration {
	if cfg.TimeoutMS > 0 {
		return time.Duration(cfg.TimeoutMS) * time.Millisecond
	}
	return defaultTimeout
}

func cloneConfig(cfg Config) Config {
	cfg.Args = append([]string(nil), cfg.Args...)
	cfg.AllowTools = append([]string(nil), cfg.AllowTools...)
	cfg.AllowDomains = append([]string(nil), cfg.AllowDomains...)
	return cfg
}

func hashArguments(args map[string]any) string {
	data, _ := json.Marshal(args)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func safeError(err error) string {
	if err == nil {
		return ""
	}
	message := strings.ReplaceAll(err.Error(), "\n", " ")
	message = bearerSecretPattern.ReplaceAllString(message, `${1}<redacted>`)
	message = keyValueSecretPattern.ReplaceAllString(message, `${1}<redacted>`)
	return message
}

func sanitizeConnectorError(err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, context.Canceled):
		return context.Canceled
	case errors.Is(err, context.DeadlineExceeded):
		return context.DeadlineExceeded
	case errors.Is(err, ErrDisabled):
		return ErrDisabled
	case errors.Is(err, ErrToolDenied):
		return ErrToolDenied
	case errors.Is(err, ErrOutputTooLarge):
		return ErrOutputTooLarge
	case errors.Is(err, ErrUnsafeURL):
		return ErrUnsafeURL
	case errors.Is(err, ErrInvalidConfig):
		return ErrInvalidConfig
	case strings.Contains(err.Error(), "secret store"):
		return errors.New("connector secret store is unavailable")
	case strings.Contains(err.Error(), "credential"):
		return errors.New("connector credential is unavailable")
	default:
		return errors.New("connector call failed")
	}
}

var (
	bearerSecretPattern   = regexp.MustCompile(`(?i)(bearer\s+)[^\s,;]+`)
	keyValueSecretPattern = regexp.MustCompile(`(?i)((?:token|api[_-]?key|secret)\s*[=:]\s*)[^\s,;]+`)
)
