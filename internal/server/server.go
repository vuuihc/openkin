package server

import (
	"context"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/adapter/claudecode"
	"github.com/vuuihc/kin/internal/api"
	"github.com/vuuihc/kin/internal/remote"
	"github.com/vuuihc/kin/internal/store"
	"github.com/vuuihc/kin/internal/task"
	"github.com/vuuihc/kin/web"
)

const defaultPort = "7777"

// Serve starts the loopback HTTP daemon (spec §7 Local: 127.0.0.1:7777).
func Serve(version string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("home dir: %w", err)
	}
	stateDir := filepath.Join(home, ".kin")
	if err := os.MkdirAll(filepath.Join(stateDir, "logs"), 0o700); err != nil {
		return fmt.Errorf("state dir: %w", err)
	}

	token, err := remote.EnsureToken(stateDir)
	if err != nil {
		return err
	}

	st, err := store.Open(filepath.Join(stateDir, "kin.db"))
	if err != nil {
		return err
	}
	defer st.Close()

	adapters := map[string]adapter.Adapter{
		"claude-code": claudecode.New(),
	}
	// Optional override for integration tests / local fake agents.
	if bin := os.Getenv("KIN_CLAUDE_BIN"); bin != "" {
		adapters["claude-code"] = &claudecode.Adapter{Binary: bin}
	}

	eng := task.NewEngine(st, adapters, task.NewBus(), task.DefaultMaxConcurrent)
	defer eng.Close()
	if err := eng.Recover(context.Background()); err != nil {
		return err
	}

	static, err := uiHandler()
	if err != nil {
		return err
	}

	srv := &api.Server{
		Store:   st,
		Auth:    remote.NewAuth(token),
		Engine:  eng,
		Version: version,
		Static:  static,
	}

	addr := "127.0.0.1:" + defaultPort
	if p := os.Getenv("KIN_PORT"); p != "" {
		addr = "127.0.0.1:" + p
	}
	fmt.Printf("kin listening on http://%s\n", addr)
	fmt.Printf("  token file: %s\n", filepath.Join(stateDir, "token"))
	fmt.Printf("  open: http://%s/?token=%s\n", addr, token)
	return http.ListenAndServe(addr, srv.Handler())
}

func uiHandler() (http.Handler, error) {
	sub, err := fs.Sub(web.FS, "dist")
	if err != nil {
		return nil, fmt.Errorf("embed web: %w", err)
	}
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// SPA fallback: serve index.html for non-file client routes.
		path := r.URL.Path
		if path != "/" && !strings.Contains(path, ".") {
			if f, err := sub.Open(strings.TrimPrefix(path, "/")); err == nil {
				_ = f.Close()
			} else {
				r = r.Clone(r.Context())
				r.URL.Path = "/"
			}
		}
		fileServer.ServeHTTP(w, r)
	}), nil
}
