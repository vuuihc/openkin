package api

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/vuuihc/openkin/internal/adapter/detect"
	"github.com/vuuihc/openkin/internal/adapter/genericcli"
	"github.com/vuuihc/openkin/internal/store"
)

// SmokeAgents runs headless smoke probes for installed Tier-2 generic CLI agents.
// Only agents that are installed (binary on PATH) are probed. Results are persisted
// via Store and surface through ListAgents / plugin Status.
// Optional; when nil, POST /api/agents/smoke returns 503.
type SmokeAgents func(ctx context.Context, ids []string) []AgentSmokeResult

// AgentSmokeResult is one agent’s smoke outcome for the API.
type AgentSmokeResult struct {
	ID        string `json:"id"`
	Name      string `json:"name,omitempty"`
	Skipped   bool   `json:"skipped,omitempty"`
	OK        bool   `json:"ok"`
	Installed bool   `json:"installed"`
	Available bool   `json:"available"`
	Binary    string `json:"binary,omitempty"`
	Detail    string `json:"detail,omitempty"`
	CheckedAt int64  `json:"checked_at,omitempty"`
}

type smokeRequest struct {
	// IDs limits the probe set. Empty = all Tier-2 generic CLI agents that are installed.
	IDs []string `json:"ids"`
}

func (s *Server) handleAgentsSmoke(w http.ResponseWriter, r *http.Request) {
	if s.SmokeAgents == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "agent smoke not configured"})
		return
	}
	var req smokeRequest
	if r.Body != nil && r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
	}
	// Bound wall time: several agents × 15s each, plus slack.
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	results := s.SmokeAgents(ctx, req.IDs)
	if results == nil {
		results = []AgentSmokeResult{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

// RunGenericCLISmoke is the composition-root helper used by server.Serve.
// It probes only installed Tier-2 agents and writes results into st.
func RunGenericCLISmoke(ctx context.Context, st *store.Store, ids []string) []AgentSmokeResult {
	if st == nil {
		return nil
	}
	invocations := detect.GenericInvocations()
	type item struct {
		id   string
		name string
		inv  detect.Invocation
		spec detect.DiscoverySpec
	}
	byID := map[string]item{}
	for _, sp := range detect.SkillsDiscoveryCatalog() {
		inv, ok := invocations[sp.ID]
		if !ok {
			continue
		}
		byID[sp.ID] = item{id: sp.ID, name: sp.Name, inv: inv, spec: sp}
	}
	for id, inv := range invocations {
		if _, ok := byID[id]; ok {
			continue
		}
		byID[id] = item{
			id:   id,
			name: id,
			inv:  inv,
			spec: detect.DiscoverySpec{ID: id, Name: id, Bins: inv.BinCandidates},
		}
	}

	want := map[string]bool{}
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id != "" {
			want[id] = true
		}
	}

	var work []item
	if len(want) == 0 {
		for _, it := range byID {
			work = append(work, it)
		}
	} else {
		for id := range want {
			if it, ok := byID[id]; ok {
				work = append(work, it)
			}
		}
	}
	sort.Slice(work, func(i, j int) bool { return work[i].id < work[j].id })

	const maxParallel = 3
	sem := make(chan struct{}, maxParallel)
	var mu sync.Mutex
	results := make([]AgentSmokeResult, 0, len(work)+len(want))

	for id := range want {
		if _, ok := byID[id]; !ok {
			results = append(results, AgentSmokeResult{
				ID:      id,
				Skipped: true,
				Detail:  "not a Tier-2 generic CLI agent",
			})
		}
	}

	var wg sync.WaitGroup
	for _, it := range work {
		it := it
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				mu.Lock()
				results = append(results, AgentSmokeResult{
					ID: it.id, Name: it.name, Skipped: true, Detail: "canceled",
				})
				mu.Unlock()
				return
			}

			path, reason := resolveSmokeBinary(it.spec, it.inv)
			now := time.Now().Unix()
			if path == "" {
				detail := reason
				if detail == "" {
					detail = "not installed"
				}
				mu.Lock()
				results = append(results, AgentSmokeResult{
					ID:        it.id,
					Name:      it.name,
					Skipped:   true,
					Installed: false,
					Available: false,
					Detail:    detail,
					CheckedAt: now,
				})
				mu.Unlock()
				return
			}

			res := genericcli.Smoke(ctx, it.inv, path)
			_ = st.SetAgentSmoke(ctx, it.id, store.AgentSmokeResult{
				OK:        res.OK,
				Binary:    path,
				CheckedAt: now,
				Detail:    res.Detail,
			})
			mu.Lock()
			results = append(results, AgentSmokeResult{
				ID:        it.id,
				Name:      it.name,
				OK:        res.OK,
				Installed: true,
				Available: res.OK,
				Binary:    path,
				Detail:    res.Detail,
				CheckedAt: now,
			})
			mu.Unlock()
		}()
	}
	wg.Wait()

	sort.Slice(results, func(i, j int) bool { return results[i].ID < results[j].ID })
	return results
}

func resolveSmokeBinary(spec detect.DiscoverySpec, inv detect.Invocation) (string, string) {
	look := exec.LookPath
	if env := strings.TrimSpace(spec.EnvBin); env != "" {
		if v := strings.TrimSpace(os.Getenv(env)); v != "" {
			if path, err := look(v); err == nil {
				return path, ""
			}
			if _, err := os.Stat(v); err == nil {
				return v, ""
			}
		}
	}
	candidates := inv.BinCandidates
	if len(candidates) == 0 {
		candidates = spec.Bins
	}
	for _, c := range candidates {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		if path, err := look(c); err == nil {
			return path, ""
		}
	}
	if len(candidates) == 0 {
		return "", "no binary candidates configured"
	}
	return "", "not installed"
}
