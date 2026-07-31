package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/vuuihc/openkin/internal/provider"
	"github.com/vuuihc/openkin/internal/routing"
	"github.com/vuuihc/openkin/internal/store"
)

// Settings keys for routing configuration.
const (
	settingsKeyRoutingProfiles  = "routing.profiles"
	settingsKeyRoutingDefaults  = "routing.defaults"
	settingsKeyProviderProfiles = "routing.provider_profiles"
)

// handleGetRoutingOptions serves GET /api/routing/options.
func (s *Server) handleGetRoutingOptions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Load provider profiles.
	providerProfiles, err := loadProviderProfiles(ctx, s.Store)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// Load team profiles.
	teamProfiles, err := loadTeamProfiles(ctx, s.Store)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// Load routing defaults.
	defaults, err := loadRoutingDefaults(ctx, s.Store)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// Build agent info from engine.
	var agents []routing.AgentInfo
	if s.Engine != nil {
		for _, id := range s.Engine.AgentIDs() {
			agents = append(agents, routing.AgentInfo{
				ID:   id,
				Name: id,
			})
		}
	}

	opts := routing.BuildOptions(agents, providerProfiles, teamProfiles, defaults)
	writeJSON(w, http.StatusOK, opts)
}

// handleGetRoutingPreview serves GET /api/routing/preview.
func (s *Server) handleGetRoutingPreview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()

	mode := routing.DispatchMode(q.Get("mode"))
	if mode == "" {
		mode = routing.DispatchAuto
	}

	providerProfiles, err := loadProviderProfiles(ctx, s.Store)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	teamProfiles, err := loadTeamProfiles(ctx, s.Store)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	switch mode {
	case routing.DispatchAuto:
		teamID := q.Get("team")
		objective := routing.DispatchObjective(q.Get("objective"))

		// Find the team, preferring exact ID match over alias.
		var team *routing.TeamProfile
		for i := range teamProfiles {
			if teamProfiles[i].ID == teamID {
				team = &teamProfiles[i]
				break
			}
		}
		if team == nil {
			for i := range teamProfiles {
				if teamProfiles[i].Alias == teamID {
					team = &teamProfiles[i]
					break
				}
			}
		}
		if team == nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "team not found: " + teamID})
			return
		}

		preview := routing.BuildAutoPreview(*team, objective, providerProfiles)
		writeJSON(w, http.StatusOK, preview)

	case routing.DispatchManual:
		agent := q.Get("agent")
		provider := q.Get("provider")
		model := q.Get("model")

		if agent == "" || provider == "" || model == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "manual mode requires agent, provider, and model"})
			return
		}

		preview := routing.BuildManualPreview(agent, provider, model, providerProfiles)
		writeJSON(w, http.StatusOK, preview)

	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown mode: " + string(mode)})
	}
}

// handlePutRoutingDefaults serves PUT /api/routing/defaults.
func (s *Server) handlePutRoutingDefaults(w http.ResponseWriter, r *http.Request) {
	var defaults routing.RoutingDefaults
	if err := json.NewDecoder(r.Body).Decode(&defaults); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}

	// Load team profiles for validation.
	teamProfiles, err := loadTeamProfiles(r.Context(), s.Store)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	teamExists := func(id string) bool {
		for _, t := range teamProfiles {
			if t.ID == id {
				return true
			}
		}
		return false
	}

	if err := routing.ValidateRoutingDefaults(defaults, teamExists); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	if err := saveRoutingDefaults(r.Context(), s.Store, defaults); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, defaults)
}

// handleGetRoutingDefaults serves GET /api/routing/defaults.
func (s *Server) handleGetRoutingDefaults(w http.ResponseWriter, r *http.Request) {
	defaults, err := loadRoutingDefaults(r.Context(), s.Store)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, defaults)
}

// handlePutRoutingProfiles serves PUT /api/routing/profiles.
func (s *Server) handlePutRoutingProfiles(w http.ResponseWriter, r *http.Request) {
	var list routing.TeamProfileList
	if err := json.NewDecoder(r.Body).Decode(&list); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}

	// Load provider profiles for validation.
	providerProfiles, err := loadProviderProfiles(r.Context(), s.Store)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	agentExists := func(id string) bool {
		if s.Engine == nil {
			return id == "kin" || id == "claude-code" || id == "codex" || id == "grok"
		}
		return s.Engine.HasAgent(id)
	}
	providerExists := func(id string) bool {
		for _, p := range providerProfiles {
			if p.ID == id {
				return true
			}
		}
		return false
	}

	// Validate all profiles.
	for _, t := range list.Profiles {
		if err := routing.ValidateTeamProfile(t, agentExists, providerExists, providerProfiles); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}

	// Check alias conflicts.
	for _, t := range list.Profiles {
		if t.Alias == "" {
			continue
		}
		if conflict := routing.CheckAliasConflict(t.Alias, t.ID, list.Profiles); conflict != "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": "alias " + t.Alias + " conflicts with team " + conflict,
			})
			return
		}
	}

	if err := saveTeamProfiles(r.Context(), s.Store, list.Profiles); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, list)
}

// handleGetRoutingProfiles serves GET /api/routing/profiles.
func (s *Server) handleGetRoutingProfiles(w http.ResponseWriter, r *http.Request) {
	profiles, err := loadTeamProfiles(r.Context(), s.Store)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, routing.TeamProfileList{Profiles: profiles})
}

// handlePutProviderProfiles serves PUT /api/routing/provider-profiles.
func (s *Server) handlePutProviderProfiles(w http.ResponseWriter, r *http.Request) {
	var list routing.ProviderProfileList
	if err := json.NewDecoder(r.Body).Decode(&list); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}

	for _, p := range list.Profiles {
		if err := routing.ValidateProviderProfile(p); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}

	if err := saveProviderProfiles(r.Context(), s.Store, list.Profiles); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, list)
}

// handleGetProviderProfiles serves GET /api/routing/provider-profiles.
func (s *Server) handleGetProviderProfiles(w http.ResponseWriter, r *http.Request) {
	profiles, err := loadProviderProfiles(r.Context(), s.Store)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, routing.ProviderProfileList{Profiles: profiles})
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

func loadProviderProfiles(ctx context.Context, st *store.Store) ([]routing.ProviderProfile, error) {
	reg, err := provider.LoadRegistry(ctx, st)
	if err != nil {
		return nil, err
	}
	profiles := make([]routing.ProviderProfile, 0, len(reg.Entries))
	for _, e := range reg.Entries {
		models := make([]routing.ModelSpec, len(e.Models))
		for i, m := range e.Models {
			models[i] = routing.ModelSpec{
				ID:        m.ID,
				Tier:      m.Tier,
				CostLabel: m.CostLabel,
			}
		}
		enabled := true // default for old entries (pre-Enabled field)
		if e.Enabled != nil {
			enabled = *e.Enabled
		}
		profiles = append(profiles, routing.ProviderProfile{
			ID:             e.ID,
			Name:           e.Name,
			Kind:           routing.ProviderKind(e.Kind),
			SupportsAgents: e.SupportsAgents,
			Enabled:        enabled,
			Models:         models,
		})
	}
	return profiles, nil
}

func saveProviderProfiles(ctx context.Context, st *store.Store, profiles []routing.ProviderProfile) error {
	reg, err := provider.LoadRegistry(ctx, st)
	if err != nil {
		return err
	}
	// Update each registry entry with routing fields from profiles.
	for _, pp := range profiles {
		found := false
		for i, e := range reg.Entries {
			if e.ID == pp.ID {
				reg.Entries[i].SupportsAgents = pp.SupportsAgents
				reg.Entries[i].Kind = string(pp.Kind)
				enabledCopy := pp.Enabled
				reg.Entries[i].Enabled = &enabledCopy
				reg.Entries[i].Models = make([]provider.ModelSpec, len(pp.Models))
				for j, m := range pp.Models {
					reg.Entries[i].Models[j] = provider.ModelSpec{
						ID:        m.ID,
						Tier:      m.Tier,
						CostLabel: m.CostLabel,
					}
				}
				found = true
				break
			}
		}
		if !found {
			// New routing-only entry (e.g. subscription provider without runtime config).
			models := make([]provider.ModelSpec, len(pp.Models))
			for j, m := range pp.Models {
				models[j] = provider.ModelSpec{
					ID:        m.ID,
					Tier:      m.Tier,
					CostLabel: m.CostLabel,
				}
			}
			reg.Entries = append(reg.Entries, provider.Entry{
				ID:             pp.ID,
				Name:           pp.Name,
				Kind:           string(pp.Kind),
				SupportsAgents: pp.SupportsAgents,
				Models:         models,
			}.Normalize())
		}
	}
	return provider.SaveRegistry(ctx, st, reg)
}

func loadTeamProfiles(ctx context.Context, st *store.Store) ([]routing.TeamProfile, error) {
	var list routing.TeamProfileList
	raw, err := st.GetSetting(ctx, settingsKeyRoutingProfiles)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, nil
		}
		return nil, err
	}
	if raw == "" {
		return nil, nil
	}
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return nil, err
	}
	if list.Profiles == nil {
		list.Profiles = []routing.TeamProfile{}
	}
	return list.Profiles, nil
}

func saveTeamProfiles(ctx context.Context, st *store.Store, profiles []routing.TeamProfile) error {
	list := routing.TeamProfileList{Profiles: profiles}
	if list.Profiles == nil {
		list.Profiles = []routing.TeamProfile{}
	}
	b, err := json.Marshal(list)
	if err != nil {
		return err
	}
	return st.SetSetting(ctx, settingsKeyRoutingProfiles, string(b))
}

func loadRoutingDefaults(ctx context.Context, st *store.Store) (routing.RoutingDefaults, error) {
	raw, err := st.GetSetting(ctx, settingsKeyRoutingDefaults)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return routing.DefaultRoutingDefaults(), nil
		}
		return routing.RoutingDefaults{}, err
	}
	if raw == "" {
		return routing.DefaultRoutingDefaults(), nil
	}
	var d routing.RoutingDefaults
	if err := json.Unmarshal([]byte(raw), &d); err != nil {
		return routing.RoutingDefaults{}, err
	}
	return d, nil
}

func saveRoutingDefaults(ctx context.Context, st *store.Store, d routing.RoutingDefaults) error {
	b, err := json.Marshal(d)
	if err != nil {
		return err
	}
	return st.SetSetting(ctx, settingsKeyRoutingDefaults, string(b))
}
