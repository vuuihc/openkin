package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/vuuihc/openkin/internal/routing"
)

// handleGetRoutingOptions serves GET /api/routing/options.
func (s *Server) handleGetRoutingOptions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Load provider profiles.
	catalog := s.routingCatalog()
	providerProfiles, err := catalog.ListProviderProfiles(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// Load team profiles.
	teamProfiles, err := catalog.ListTeamProfiles(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// Load routing defaults.
	defaults, err := catalog.GetRoutingDefaults(ctx)
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

	catalog := s.routingCatalog()
	providerProfiles, err := catalog.ListProviderProfiles(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	teamProfiles, err := catalog.ListTeamProfiles(ctx)
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

	if err := s.routingCatalog().SaveRoutingDefaults(r.Context(), defaults); err != nil {
		writeRoutingCatalogError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, defaults)
}

// handleGetRoutingDefaults serves GET /api/routing/defaults.
func (s *Server) handleGetRoutingDefaults(w http.ResponseWriter, r *http.Request) {
	defaults, err := s.routingCatalog().GetRoutingDefaults(r.Context())
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

	if err := s.routingCatalog().SaveTeamProfiles(r.Context(), list.Profiles); err != nil {
		writeRoutingCatalogError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, list)
}

// handleGetRoutingProfiles serves GET /api/routing/profiles.
func (s *Server) handleGetRoutingProfiles(w http.ResponseWriter, r *http.Request) {
	profiles, err := s.routingCatalog().ListTeamProfiles(r.Context())
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

	if err := s.routingCatalog().SaveProviderProfiles(r.Context(), list.Profiles); err != nil {
		writeRoutingCatalogError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, list)
}

// handleGetProviderProfiles serves GET /api/routing/provider-profiles.
func (s *Server) handleGetProviderProfiles(w http.ResponseWriter, r *http.Request) {
	profiles, err := s.routingCatalog().ListProviderProfiles(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, routing.ProviderProfileList{Profiles: profiles})
}

func (s *Server) routingCatalog() *routing.Catalog {
	if s.Engine == nil {
		return routing.NewCatalog(s.Store, nil)
	}
	return routing.NewCatalog(s.Store, s.Engine.HasAgent)
}

func writeRoutingCatalogError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	if errors.Is(err, routing.ErrInvalidConfig) {
		status = http.StatusBadRequest
	}
	writeJSON(w, status, map[string]string{"error": err.Error()})
}
