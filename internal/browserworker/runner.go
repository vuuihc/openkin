// Package browserworker bridges the optional Playwright worker to durable Kin
// task events, approvals, and artifacts.
package browserworker

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

const (
	defaultApprovalTimeout = 30 * time.Second
	defaultMaxEvidence     = 5 << 20
	maxWorkerFrameBytes    = 8 << 20
	maxArtifactBody        = 5 << 20
)

var (
	ErrNotConfigured = errors.New("browser worker is not configured")
	ErrTaskBusy      = errors.New("browser action already running for task")
	ErrClosed        = errors.New("browser worker is closed")
)

// Action is the structured action accepted by the Playwright worker.
type Action struct {
	Type       string `json:"type"`
	URL        string `json:"url,omitempty"`
	Selector   string `json:"selector,omitempty"`
	Value      string `json:"value,omitempty"`
	Key        string `json:"key,omitempty"`
	Path       string `json:"path,omitempty"`
	Filename   string `json:"filename,omitempty"`
	Name       string `json:"name,omitempty"`
	SideEffect bool   `json:"side_effect,omitempty"`
	Sensitive  bool   `json:"sensitive,omitempty"`
}

// Config controls the worker process and its filesystem/network policy.
// Command is intentionally explicit so production can package Node and
// Playwright separately from the Go daemon.
type Config struct {
	Command        []string
	WorkingDir     string
	AllowedDomains []string
	DownloadDir    string
	UploadDir      string
	MaxDownload    int64
	MaxEvidence    int64
	ApprovalTTL    time.Duration
	ArtifactsDir   string
	Store          *store.Store
	Engine         *task.Engine
	Bus            *task.Bus
}

// Runner executes one isolated worker process per action.
type Runner struct {
	cfg Config

	mu      sync.Mutex
	running map[string]context.CancelFunc
	closed  bool
	wg      sync.WaitGroup
}

// New validates and creates a browser worker bridge.
func New(cfg Config) (*Runner, error) {
	if len(cfg.Command) == 0 || strings.TrimSpace(cfg.Command[0]) == "" {
		return nil, ErrNotConfigured
	}
	if cfg.Store == nil || cfg.Engine == nil {
		return nil, fmt.Errorf("browser worker requires store and task engine")
	}
	if cfg.ApprovalTTL <= 0 {
		cfg.ApprovalTTL = defaultApprovalTimeout
	}
	if cfg.MaxEvidence <= 0 {
		cfg.MaxEvidence = defaultMaxEvidence
	}
	if cfg.MaxDownload <= 0 {
		cfg.MaxDownload = 10 << 20
	}
	if cfg.DownloadDir == "" || cfg.UploadDir == "" {
		return nil, fmt.Errorf("browser worker download and upload directories are required")
	}
	if cfg.ArtifactsDir == "" {
		return nil, fmt.Errorf("browser worker artifacts directory is required")
	}
	return &Runner{cfg: cfg, running: make(map[string]context.CancelFunc)}, nil
}

type actionRequest struct {
	ID     string `json:"id"`
	Type   string `json:"type"`
	Action Action `json:"action"`
}

type approvalResponse struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Approved bool   `json:"approved"`
}

type workerMessage struct {
	ID       string          `json:"id"`
	Type     string          `json:"type"`
	OK       bool            `json:"ok"`
	Error    string          `json:"error,omitempty"`
	Action   json.RawMessage `json:"action,omitempty"`
	Evidence []evidence      `json:"evidence,omitempty"`
}

type evidence struct {
	Kind       string         `json:"kind"`
	Name       string         `json:"name,omitempty"`
	MIME       string         `json:"mime,omitempty"`
	Size       int64          `json:"size"`
	SHA256     string         `json:"sha256"`
	BodyBase64 string         `json:"body_base64,omitempty"`
	Metadata   map[string]any `json:"metadata,omitempty"`
}

// Execute runs an action attached to taskID and persists its evidence.
func (r *Runner) Execute(ctx context.Context, taskID string, action Action) (err error) {
	if strings.TrimSpace(taskID) == "" {
		return fmt.Errorf("task_id is required")
	}
	if strings.TrimSpace(action.Type) == "" {
		return fmt.Errorf("browser action type is required")
	}
	switch action.Type {
	case "navigate", "click", "fill", "press", "download", "upload", "screenshot":
	default:
		return fmt.Errorf("unsupported browser action %q", action.Type)
	}
	if _, err := r.cfg.Store.GetTask(ctx, taskID); err != nil {
		return err
	}

	runCtx, cancel := context.WithCancel(ctx)
	if !r.claim(taskID, cancel) {
		cancel()
		r.mu.Lock()
		closed := r.closed
		r.mu.Unlock()
		if closed {
			return ErrClosed
		}
		return ErrTaskBusy
	}
	defer r.release(taskID)

	requestID := ulid.Make().String()
	failureEventEmitted := false
	defer func() {
		if err == nil || failureEventEmitted {
			return
		}
		_ = r.emit(context.Background(), taskID, "browser_action_failed", map[string]any{
			"request_id": requestID,
			"error":      redactWorkerError(err.Error()),
		})
	}()
	if err := r.emit(ctx, taskID, "browser_action_started", map[string]any{
		"request_id": requestID,
		"action":     sanitizeAction(action),
	}); err != nil {
		return fmt.Errorf("persist browser action start: %w", err)
	}

	cmd := exec.CommandContext(runCtx, r.cfg.Command[0], r.cfg.Command[1:]...)
	cmd.Dir = r.cfg.WorkingDir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stdin = nil
	cmd.Stderr = io.Discard
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("browser worker stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("browser worker stdout: %w", err)
	}
	cmd.Env = append(workerEnvironment(),
		"KIN_BROWSER_DOMAINS="+strings.Join(r.cfg.AllowedDomains, ","),
		"KIN_BROWSER_DOWNLOAD_DIR="+r.cfg.DownloadDir,
		"KIN_BROWSER_UPLOAD_DIR="+r.cfg.UploadDir,
		fmt.Sprintf("KIN_BROWSER_MAX_DOWNLOAD_BYTES=%d", r.cfg.MaxDownload),
		fmt.Sprintf("KIN_BROWSER_MAX_EVIDENCE_BYTES=%d", r.cfg.MaxEvidence),
	)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start browser worker: %w", err)
	}
	killDone := make(chan struct{})
	go func(pid int) {
		select {
		case <-runCtx.Done():
			_ = syscall.Kill(-pid, syscall.SIGKILL)
		case <-killDone:
		}
	}(cmd.Process.Pid)
	defer close(killDone)

	encoder := json.NewEncoder(stdin)
	if err := encoder.Encode(actionRequest{
		ID: requestID, Type: "action", Action: action,
	}); err != nil {
		cancel()
		_ = cmd.Wait()
		return fmt.Errorf("send browser action: %w", err)
	}

	// The worker's approval response is sent through a separate process
	// stdin protocol. The worker does not receive the daemon's auth token.
	var result *workerMessage
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), maxWorkerFrameBytes)
	for scanner.Scan() {
		var message workerMessage
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
			cancel()
			_ = cmd.Wait()
			return fmt.Errorf("decode browser worker frame: %w", err)
		}
		switch message.Type {
		case "approval_required":
			approved, err := r.requestApproval(runCtx, taskID, requestID, message.Action)
			if err != nil {
				cancel()
				_ = cmd.Wait()
				return err
			}
			if err := encoder.Encode(approvalResponse{
				ID: requestID, Type: "approval", Approved: approved,
			}); err != nil {
				cancel()
				_ = cmd.Wait()
				return fmt.Errorf("send browser approval: %w", err)
			}
		case "result":
			result = &message
		}
		if result != nil {
			break
		}
	}
	_ = stdin.Close()
	if err := scanner.Err(); err != nil && !errors.Is(err, context.Canceled) {
		cancel()
		_ = cmd.Wait()
		return fmt.Errorf("read browser worker: %w", err)
	}
	waitErr := cmd.Wait()
	if result == nil {
		if runCtx.Err() != nil {
			return runCtx.Err()
		}
		if waitErr != nil {
			return fmt.Errorf("browser worker exited: %w", waitErr)
		}
		return fmt.Errorf("browser worker returned no result")
	}
	if err := r.persistEvidence(ctx, taskID, requestID, result.Evidence); err != nil {
		return err
	}
	if !result.OK {
		message := redactWorkerError(result.Error)
		failureEventEmitted = true
		_ = r.emit(ctx, taskID, "browser_action_failed", map[string]any{
			"request_id": requestID,
			"error":      message,
		})
		return fmt.Errorf("browser action failed: %s", message)
	}
	if err := r.emit(ctx, taskID, "browser_action_finished", map[string]any{
		"request_id": requestID,
		"evidence":   len(result.Evidence),
	}); err != nil {
		return fmt.Errorf("persist browser action result: %w", err)
	}
	return waitErr
}

func (r *Runner) requestApproval(
	ctx context.Context,
	taskID, requestID string,
	action json.RawMessage,
) (bool, error) {
	if len(action) == 0 {
		action = json.RawMessage(`{}`)
	}
	var typedAction Action
	if err := json.Unmarshal(action, &typedAction); err == nil {
		sanitized, marshalErr := json.Marshal(sanitizeAction(typedAction))
		if marshalErr != nil {
			return false, fmt.Errorf("sanitize browser approval: %w", marshalErr)
		}
		action = sanitized
	}
	payload, err := json.Marshal(map[string]any{
		"request_id": requestID,
		"action":     action,
		"source":     "playwright",
	})
	if err != nil {
		return false, fmt.Errorf("encode browser approval: %w", err)
	}
	approval, err := r.cfg.Engine.RequestApproval(ctx, task.CreateApprovalRequest{
		TaskID:  taskID,
		Kind:    "browser_side_effect",
		Payload: payload,
	})
	if err != nil {
		return false, fmt.Errorf("request browser approval: %w", err)
	}
	decision, err := r.cfg.Engine.WaitApproval(ctx, approval.ID, r.cfg.ApprovalTTL)
	if err != nil {
		return false, fmt.Errorf("wait browser approval: %w", err)
	}
	return decision.Decision == store.DecisionApproved, nil
}

func (r *Runner) persistEvidence(ctx context.Context, taskID, requestID string, records []evidence) error {
	for _, record := range records {
		body, err := base64.StdEncoding.DecodeString(record.BodyBase64)
		if err != nil {
			return fmt.Errorf("decode browser evidence %s: %w", record.Kind, err)
		}
		if int64(len(body)) > r.cfg.MaxEvidence {
			return fmt.Errorf("browser evidence %s exceeds size limit", record.Kind)
		}
		sum := sha256.Sum256(body)
		if record.SHA256 != "" && !strings.EqualFold(record.SHA256, hex.EncodeToString(sum[:])) {
			return fmt.Errorf("browser evidence %s hash mismatch", record.Kind)
		}
		envelope, err := json.Marshal(map[string]any{
			"request_id":  requestID,
			"kind":        record.Kind,
			"name":        record.Name,
			"mime":        record.MIME,
			"size":        len(body),
			"sha256":      hex.EncodeToString(sum[:]),
			"metadata":    record.Metadata,
			"body_base64": base64.StdEncoding.EncodeToString(body),
		})
		if err != nil {
			return fmt.Errorf("encode browser evidence: %w", err)
		}
		if len(envelope) > maxArtifactBody {
			return fmt.Errorf("browser evidence %s artifact exceeds size limit", record.Kind)
		}
		id := ulid.Make().String()
		relPath := filepath.Join(time.Now().UTC().Format("2006"), time.Now().UTC().Format("01"), id+".txt")
		fullPath := filepath.Join(r.cfg.ArtifactsDir, relPath)
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o700); err != nil {
			return fmt.Errorf("create browser artifact directory: %w", err)
		}
		if err := os.WriteFile(fullPath, envelope, 0o600); err != nil {
			return fmt.Errorf("write browser artifact: %w", err)
		}
		sourceTaskID := taskID
		if err := r.cfg.Store.InsertArtifact(ctx, store.Artifact{
			ID:           id,
			Title:        fmt.Sprintf("Browser %s", record.Kind),
			Kind:         store.ArtifactKindText,
			RelPath:      relPath,
			Size:         int64(len(envelope)),
			Status:       store.ArtifactProposed,
			SourceTaskID: &sourceTaskID,
		}); err != nil {
			_ = os.Remove(fullPath)
			return fmt.Errorf("insert browser artifact: %w", err)
		}
		if err := r.emit(ctx, taskID, "browser_evidence", map[string]any{
			"request_id":  requestID,
			"artifact_id": id,
			"kind":        record.Kind,
			"size":        len(body),
			"sha256":      hex.EncodeToString(sum[:]),
		}); err != nil {
			return fmt.Errorf("persist browser evidence event: %w", err)
		}
	}
	return nil
}

func (r *Runner) emit(ctx context.Context, taskID, typ string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = r.cfg.Engine.AppendExternalEvent(ctx, taskID, typ, body)
	if err != nil {
		return err
	}
	return nil
}

func (r *Runner) claim(taskID string, cancel context.CancelFunc) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return false
	}
	if _, exists := r.running[taskID]; exists {
		return false
	}
	r.running[taskID] = cancel
	r.wg.Add(1)
	return true
}

func (r *Runner) release(taskID string) {
	r.mu.Lock()
	delete(r.running, taskID)
	r.mu.Unlock()
	r.wg.Done()
}

// Cancel stops the current browser action for taskID, if any.
func (r *Runner) Cancel(taskID string) bool {
	r.mu.Lock()
	cancel := r.running[taskID]
	r.mu.Unlock()
	if cancel == nil {
		return false
	}
	cancel()
	return true
}

// Close cancels all active worker processes and waits for their pipes to
// drain. It is safe to call more than once.
func (r *Runner) Close() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		r.wg.Wait()
		return
	}
	r.closed = true
	cancels := make([]context.CancelFunc, 0, len(r.running))
	for _, cancel := range r.running {
		cancels = append(cancels, cancel)
	}
	r.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	r.wg.Wait()
}

func workerEnvironment() []string {
	env := make([]string, 0, 5)
	for _, key := range []string{"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"} {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	return env
}

var (
	workerURLPattern  = regexp.MustCompile(`https?://[^\s"'<>]+`)
	workerBearer      = regexp.MustCompile(`(?i)Bearer\s+[A-Za-z0-9._~+/=-]+`)
	workerSecretParam = regexp.MustCompile(`(?i)(password|token|secret|api[_-]?key|authorization)=([^&\s]+)`)
	workerPathPattern = regexp.MustCompile(`(?:^|[\s("'` + "`" + `])/(?:[^/\s"'` + "`" + `]+/)+[^/\s"'` + "`" + `]+`)
)

func redactWorkerError(message string) string {
	message = workerBearer.ReplaceAllString(message, "Bearer [REDACTED]")
	message = workerSecretParam.ReplaceAllString(message, "$1=[REDACTED]")
	message = workerURLPattern.ReplaceAllStringFunc(message, redactURL)
	return workerPathPattern.ReplaceAllString(message, "$1[PATH_REDACTED]")
}

func redactURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "[REDACTED_URL]"
	}
	query := parsed.Query()
	for key := range query {
		switch strings.ToLower(key) {
		case "token", "secret", "password", "api_key", "apikey", "authorization":
			query.Set(key, "[REDACTED]")
		}
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func sanitizeAction(action Action) map[string]any {
	out := map[string]any{"type": action.Type}
	if action.URL != "" {
		out["url"] = "[worker policy redacts sensitive query values]"
	}
	if action.Selector != "" {
		out["selector"] = action.Selector
	}
	if action.Key != "" {
		out["key"] = action.Key
	}
	if action.Filename != "" {
		out["filename"] = action.Filename
	}
	if action.Name != "" {
		out["name"] = action.Name
	}
	if action.SideEffect {
		out["side_effect"] = true
	}
	if action.Sensitive {
		out["sensitive"] = true
	}
	return out
}
