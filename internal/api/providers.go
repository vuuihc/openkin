package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/vuuihc/openkin/internal/provider"
	"github.com/vuuihc/openkin/internal/routing"
)

// providersResponse is GET /api/providers.
type providersResponse struct {
	ActiveID  string                 `json:"active_id"`
	Providers []provider.PublicEntry `json:"providers"`
}

func (s *Server) handleListProviders(w http.ResponseWriter, r *http.Request) {
	reg, err := provider.LoadRegistryMetadata(r.Context(), s.Store)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, providersResponse{
		ActiveID:  reg.ActiveID,
		Providers: reg.Public(),
	})
}

// providerWriteBody is the body for POST/PUT provider entries.
type providerWriteBody struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	BaseURL string `json:"base_url"`
	APIKey  string `json:"api_key"`
	Model   string `json:"model"`
	// Stream is optional; nil keeps the previous value on update, defaults false on create.
	Stream      *bool `json:"stream"`
	Active      *bool `json:"active"`
	ClearAPIKey bool  `json:"clear_api_key"`
}

func (s *Server) handleCreateProvider(w http.ResponseWriter, r *http.Request) {
	var body providerWriteBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	entry := provider.Entry{
		ID:      strings.TrimSpace(body.ID),
		Name:    body.Name,
		Kind:    body.Kind,
		BaseURL: body.BaseURL,
		APIKey:  body.APIKey,
		Model:   body.Model,
	}
	if body.Stream != nil {
		entry.Stream = *body.Stream
	}
	// New entries default to becoming active when none is selected.
	makeActive := true
	if body.Active != nil {
		makeActive = *body.Active
	}
	reg, err := s.routingCatalog().UpsertProvider(r.Context(), entry, makeActive, false, false)
	if err != nil {
		writeProviderMutationError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, providersResponse{
		ActiveID:  reg.ActiveID,
		Providers: reg.Public(),
	})
}

func (s *Server) handleUpdateProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body providerWriteBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	entry := provider.Entry{
		ID:      id,
		Name:    body.Name,
		Kind:    body.Kind,
		BaseURL: body.BaseURL,
		APIKey:  body.APIKey,
		Model:   body.Model,
	}
	// False is a valid explicit value; the catalog preserves Stream under its
	// write lock when the client omits the field.
	if body.Stream != nil {
		entry.Stream = *body.Stream
	}
	// Empty/masked API key on update means "keep existing". clear_api_key forces wipe
	// after upsert by writing an empty secret explicitly.
	makeActive := false
	if body.Active != nil {
		makeActive = *body.Active
	}
	reg, err := s.routingCatalog().UpsertProvider(
		r.Context(), entry, makeActive, body.ClearAPIKey, body.Stream == nil,
	)
	if err != nil {
		writeProviderMutationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, providersResponse{
		ActiveID:  reg.ActiveID,
		Providers: reg.Public(),
	})
}

func (s *Server) handleDeleteProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if strings.TrimSpace(id) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "provider id is required"})
		return
	}
	reg, err := s.routingCatalog().DeleteProvider(r.Context(), id)
	if err != nil {
		writeProviderMutationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, providersResponse{
		ActiveID:  reg.ActiveID,
		Providers: reg.Public(),
	})
}

// providerModelsBody is the body for POST /api/providers/models.
// Used both for a saved entry (id set) and an in-progress add/edit form
// (base_url/api_key set directly, before the entry is saved).
type providerModelsBody struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	BaseURL string `json:"base_url"`
	APIKey  string `json:"api_key"`
}

type providerModelsResponse struct {
	Models []string `json:"models"`
}

func (s *Server) handleListProviderModels(w http.ResponseWriter, r *http.Request) {
	var body providerModelsBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	apiKey := body.APIKey
	// A masked key (echoed back from GET /api/providers) or an omitted key on
	// an existing entry means "use the stored secret", not "no secret".
	if strings.TrimSpace(body.ID) != "" && (apiKey == "" || provider.LooksMaskedAPIKey(apiKey)) {
		if reg, err := provider.LoadRegistry(r.Context(), s.Store); err == nil {
			if e, ok := reg.ByID(body.ID); ok {
				apiKey = e.APIKey
			}
		}
	}
	cfg := provider.Config{
		Kind:    body.Kind,
		BaseURL: body.BaseURL,
		APIKey:  apiKey,
	}.Normalize()
	models, err := provider.ListModels(r.Context(), cfg)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, providerModelsResponse{Models: models})
}

type activateProviderBody struct {
	// ID optional when path already has {id}; accepted for POST /api/providers/active.
	ID string `json:"id"`
}

func (s *Server) handleActivateProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		var body activateProviderBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
		id = body.ID
	}
	if strings.TrimSpace(id) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "provider id is required"})
		return
	}
	reg, err := s.routingCatalog().SetActiveProvider(r.Context(), id)
	if err != nil {
		writeProviderMutationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, providersResponse{
		ActiveID:  reg.ActiveID,
		Providers: reg.Public(),
	})
}

func isUnknownProvider(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "unknown provider id") || errors.Is(err, errUnknownProvider)
}

// errUnknownProvider reserved for future typed errors.
var errUnknownProvider = errors.New("unknown provider")

func writeProviderMutationError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	switch {
	case isUnknownProvider(err):
		status = http.StatusNotFound
	case errors.Is(err, routing.ErrInvalidConfig):
		status = http.StatusBadRequest
	}
	writeJSON(w, status, map[string]string{"error": err.Error()})
}
