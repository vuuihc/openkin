package terminal

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/oklog/ulid/v2"
)

const (
	MaxSessions     = 8
	ReplayBytes     = 1 << 20
	SubscriberDepth = 64
	ExitedRetention = 5 * time.Minute

	minCols = 2
	maxCols = 500
	minRows = 1
	maxRows = 200
)

var (
	ErrNotFound     = errors.New("terminal session not found")
	ErrProfile      = errors.New("invalid terminal profile")
	ErrCwd          = errors.New("invalid terminal cwd")
	ErrSize         = errors.New("invalid terminal size")
	ErrSessionLimit = errors.New("terminal session limit reached")
	ErrAttached     = errors.New("terminal session already attached")
	ErrClosed       = errors.New("terminal manager closed")
)

type CreateRequest struct {
	ProfileID string `json:"profile_id"`
	Cwd       string `json:"cwd"`
	Cols      uint16 `json:"cols"`
	Rows      uint16 `json:"rows"`
}

type SessionInfo struct {
	ID        string `json:"id"`
	ProfileID string `json:"profile_id"`
	Name      string `json:"name"`
	Cwd       string `json:"cwd"`
	Status    string `json:"status"`
	ExitCode  *int   `json:"exit_code,omitempty"`
	CreatedAt int64  `json:"created_at"`
}

type Attachment struct {
	Replay []byte
	Output <-chan []byte
	Exit   <-chan int
	detach func()
	once   sync.Once
}

func (a *Attachment) Detach() {
	if a == nil {
		return
	}
	a.once.Do(func() {
		if a.detach != nil {
			a.detach()
		}
	})
}

type Manager struct {
	mu         sync.RWMutex
	profiles   []Profile
	profileMap map[string]Profile
	sessions   map[string]*session
	closed     bool
	closeOnce  sync.Once
	reaperStop chan struct{}
	reaperDone chan struct{}
}

func NewManager(profiles []Profile) *Manager {
	copied := cloneProfiles(profiles)
	m := &Manager{
		profiles:   copied,
		profileMap: make(map[string]Profile, len(copied)),
		sessions:   make(map[string]*session),
		reaperStop: make(chan struct{}),
		reaperDone: make(chan struct{}),
	}
	for _, profile := range copied {
		m.profileMap[profile.ID] = cloneProfile(profile)
	}
	go m.reapExited()
	return m
}

func (m *Manager) Profiles() []Profile {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return cloneProfiles(m.profiles)
}

func (m *Manager) List() []SessionInfo {
	m.mu.RLock()
	sessions := make([]*session, 0, len(m.sessions))
	for _, current := range m.sessions {
		sessions = append(sessions, current)
	}
	m.mu.RUnlock()

	infos := make([]SessionInfo, 0, len(sessions))
	for _, current := range sessions {
		infos = append(infos, current.snapshotInfo())
	}
	sort.Slice(infos, func(i, j int) bool {
		if infos[i].CreatedAt == infos[j].CreatedAt {
			return infos[i].ID < infos[j].ID
		}
		return infos[i].CreatedAt < infos[j].CreatedAt
	})
	return infos
}

func (m *Manager) Create(req CreateRequest) (SessionInfo, error) {
	if req.Cols < minCols || req.Cols > maxCols || req.Rows < minRows || req.Rows > maxRows {
		return SessionInfo{}, ErrSize
	}
	if strings.TrimSpace(req.Cwd) == "" {
		return SessionInfo{}, ErrCwd
	}
	cwd, err := filepath.Abs(filepath.Clean(req.Cwd))
	if err != nil {
		return SessionInfo{}, fmt.Errorf("%w: resolve cwd: %v", ErrCwd, err)
	}
	info, err := os.Stat(cwd)
	if err != nil || !info.IsDir() {
		return SessionInfo{}, fmt.Errorf("%w: cwd must be an existing directory", ErrCwd)
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return SessionInfo{}, ErrClosed
	}
	profile, ok := m.profileMap[req.ProfileID]
	if !ok {
		return SessionInfo{}, ErrProfile
	}
	if len(m.sessions) >= MaxSessions {
		return SessionInfo{}, ErrSessionLimit
	}

	cmd := exec.Command(profile.Executable, profile.Args...)
	cmd.Dir = cwd
	cmd.Env = terminalEnvironment(os.Environ())
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: req.Cols, Rows: req.Rows})
	if err != nil {
		return SessionInfo{}, fmt.Errorf("start terminal profile %q: %w", req.ProfileID, err)
	}

	created := time.Now()
	sessionInfo := SessionInfo{
		ID:        ulid.Make().String(),
		ProfileID: profile.ID,
		Name:      profile.Name,
		Cwd:       cwd,
		Status:    "running",
		CreatedAt: created.UnixMilli(),
	}
	current := &session{
		cmd:     cmd,
		ptmx:    ptmx,
		info:    sessionInfo,
		replay:  newByteRing(ReplayBytes),
		done:    make(chan struct{}),
		created: created,
	}
	m.sessions[sessionInfo.ID] = current
	go current.run()
	return cloneSessionInfo(sessionInfo), nil
}

func (m *Manager) Attach(id string) (*Attachment, error) {
	// Keep the manager read lock until the session attachment is reserved. This
	// makes attachment atomic with Remove/reaping: once a session ID disappears
	// from the manager, a racing request cannot attach through a stale pointer.
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.closed {
		return nil, ErrClosed
	}
	current, ok := m.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}
	return current.attach()
}

func (m *Manager) Write(id string, p []byte) error {
	current, err := m.get(id)
	if err != nil {
		return err
	}
	return current.write(p)
}

func (m *Manager) Resize(id string, cols, rows uint16) error {
	if cols < minCols || cols > maxCols || rows < minRows || rows > maxRows {
		return ErrSize
	}
	current, err := m.get(id)
	if err != nil {
		return err
	}
	return current.resize(cols, rows)
}

func (m *Manager) Remove(id string) error {
	m.mu.Lock()
	current, ok := m.sessions[id]
	if ok {
		delete(m.sessions, id)
	}
	m.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	return current.shutdown()
}

func (m *Manager) Close() error {
	var closeErr error
	m.closeOnce.Do(func() {
		m.mu.Lock()
		m.closed = true
		sessions := make([]*session, 0, len(m.sessions))
		for id, current := range m.sessions {
			sessions = append(sessions, current)
			delete(m.sessions, id)
		}
		close(m.reaperStop)
		m.mu.Unlock()

		var wg sync.WaitGroup
		errs := make(chan error, len(sessions))
		for _, current := range sessions {
			wg.Add(1)
			go func(current *session) {
				defer wg.Done()
				if err := current.shutdown(); err != nil {
					errs <- err
				}
			}(current)
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			closeErr = errors.Join(closeErr, err)
		}
		<-m.reaperDone
	})
	return closeErr
}

func (m *Manager) get(id string) (*session, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.closed {
		return nil, ErrClosed
	}
	current, ok := m.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}
	return current, nil
}

func (m *Manager) reapExited() {
	defer close(m.reaperDone)
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case now := <-ticker.C:
			m.mu.Lock()
			for id, current := range m.sessions {
				if current.expired(now) {
					delete(m.sessions, id)
				}
			}
			m.mu.Unlock()
		case <-m.reaperStop:
			return
		}
	}
}

type session struct {
	mu           sync.Mutex
	writeMu      sync.Mutex
	cmd          *exec.Cmd
	ptmx         *os.File
	info         SessionInfo
	replay       *byteRing
	subscriber   *subscriber
	done         chan struct{}
	created      time.Time
	exitedAt     time.Time
	closeOnce    sync.Once
	closePTYOnce sync.Once
}

func (s *session) run() {
	defer s.closePTY()
	buf := make([]byte, 32<<10)
	for {
		n, err := s.ptmx.Read(buf)
		if n > 0 {
			s.publish(buf[:n])
		}
		if err != nil {
			break
		}
	}

	waitErr := s.cmd.Wait()
	code := 0
	if s.cmd.ProcessState != nil {
		code = s.cmd.ProcessState.ExitCode()
	} else if waitErr != nil {
		code = 1
	}

	s.mu.Lock()
	s.info.Status = "exited"
	s.info.ExitCode = intPointer(code)
	s.exitedAt = time.Now()
	sub := s.subscriber
	s.mu.Unlock()
	if sub != nil {
		sub.sendExit(code)
	}
	close(s.done)
}

func (s *session) publish(p []byte) {
	chunk := append([]byte(nil), p...)
	s.mu.Lock()
	s.replay.Append(chunk)
	sub := s.subscriber
	s.mu.Unlock()
	if sub != nil && !sub.sendOutput(chunk) {
		s.detachSubscriber(sub)
	}
}

func (s *session) snapshotInfo() SessionInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneSessionInfo(s.info)
}

func (s *session) attach() (*Attachment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.subscriber != nil {
		return nil, ErrAttached
	}
	sub := newSubscriber()
	s.subscriber = sub
	attachment := &Attachment{
		Replay: s.replay.Snapshot(),
		Output: sub.output,
		Exit:   sub.exit,
	}
	attachment.detach = func() { s.detachSubscriber(sub) }
	if s.info.Status == "exited" && s.info.ExitCode != nil {
		sub.sendExit(*s.info.ExitCode)
	}
	return attachment, nil
}

func (s *session) detachSubscriber(sub *subscriber) {
	s.mu.Lock()
	if s.subscriber == sub {
		s.subscriber = nil
	}
	s.mu.Unlock()
	sub.close()
}

func (s *session) write(p []byte) error {
	s.mu.Lock()
	running := s.info.Status == "running"
	s.mu.Unlock()
	if !running {
		return ErrClosed
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.ptmx.Write(p)
	if err != nil {
		return fmt.Errorf("write terminal input: %w", err)
	}
	return nil
}

func (s *session) resize(cols, rows uint16) error {
	s.mu.Lock()
	running := s.info.Status == "running"
	s.mu.Unlock()
	if !running {
		return ErrClosed
	}
	if err := pty.Setsize(s.ptmx, &pty.Winsize{Cols: cols, Rows: rows}); err != nil {
		return fmt.Errorf("resize terminal: %w", err)
	}
	return nil
}

func (s *session) shutdown() error {
	var shutdownErr error
	s.closeOnce.Do(func() {
		s.mu.Lock()
		running := s.info.Status == "running"
		if running {
			s.info.Status = "closing"
		}
		s.mu.Unlock()

		if !running {
			s.closePTY()
			return
		}
		if s.cmd.Process != nil {
			if err := signalTerminalProcess(s.cmd.Process, syscall.SIGTERM); err != nil {
				shutdownErr = fmt.Errorf("terminate terminal process group: %w", err)
			}
		}
		s.closePTY()

		timer := time.NewTimer(5 * time.Second)
		defer timer.Stop()
		select {
		case <-s.done:
			return
		case <-timer.C:
			if s.cmd.Process != nil {
				if err := signalTerminalProcess(s.cmd.Process, syscall.SIGKILL); err != nil {
					shutdownErr = errors.Join(shutdownErr, fmt.Errorf("kill terminal process group: %w", err))
				}
			}
			<-s.done
		}
	})
	return shutdownErr
}

func signalTerminalProcess(process *os.Process, signal syscall.Signal) error {
	err := syscall.Kill(-process.Pid, signal)
	if err == nil || errors.Is(err, syscall.ESRCH) {
		return nil
	}
	if !errors.Is(err, syscall.EPERM) {
		return err
	}
	if err := process.Signal(signal); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	return nil
}

func (s *session) closePTY() {
	s.closePTYOnce.Do(func() { _ = s.ptmx.Close() })
}

func (s *session) expired(now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.info.Status == "exited" && !s.exitedAt.IsZero() && now.Sub(s.exitedAt) >= ExitedRetention
}

type subscriber struct {
	mu     sync.Mutex
	output chan []byte
	exit   chan int
	closed bool
}

func newSubscriber() *subscriber {
	return &subscriber{
		output: make(chan []byte, SubscriberDepth),
		exit:   make(chan int, 1),
	}
}

func (s *subscriber) sendOutput(p []byte) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false
	}
	select {
	case s.output <- append([]byte(nil), p...):
		return true
	default:
		s.closeLocked()
		return false
	}
}

func (s *subscriber) sendExit(code int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	select {
	case s.exit <- code:
	default:
	}
}

func (s *subscriber) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closeLocked()
}

func (s *subscriber) closeLocked() {
	if s.closed {
		return
	}
	s.closed = true
	close(s.output)
	close(s.exit)
}

func cloneProfile(profile Profile) Profile {
	profile.Args = append([]string(nil), profile.Args...)
	return profile
}

func cloneProfiles(profiles []Profile) []Profile {
	if len(profiles) == 0 {
		return []Profile{}
	}
	result := make([]Profile, len(profiles))
	for i, profile := range profiles {
		result[i] = cloneProfile(profile)
	}
	return result
}

func cloneSessionInfo(info SessionInfo) SessionInfo {
	if info.ExitCode != nil {
		info.ExitCode = intPointer(*info.ExitCode)
	}
	return info
}

func intPointer(value int) *int { return &value }

func terminalEnvironment(environ []string) []string {
	overrides := map[string]string{
		"TERM":         "xterm-256color",
		"COLORTERM":    "truecolor",
		"TERM_PROGRAM": "Kin",
	}
	result := make([]string, 0, len(environ)+len(overrides))
	for _, entry := range environ {
		key, _, ok := strings.Cut(entry, "=")
		if ok {
			if _, replaced := overrides[key]; replaced {
				continue
			}
		}
		result = append(result, entry)
	}
	for _, key := range []string{"TERM", "COLORTERM", "TERM_PROGRAM"} {
		result = append(result, key+"="+overrides[key])
	}
	return result
}
