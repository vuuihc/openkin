package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/vuuihc/kin/internal/provider"
	"github.com/vuuihc/kin/internal/store"
)

// providersResponse is GET /api/providers.
type providersResponse struct {
	ActiveID  string                 `json:"active_id"`
	Providers []provider.PublicEntry `json:"providers"`
}

func (s *Server) handleListProviders(w http.ResponseWriter, r *http.Request) {
	reg, err := provider.LoadRegistry(r.Context(), s.Store)
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
	ID          string `json:"id"`
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	BaseURL     string `json:"base_url"`
	APIKey      string `json:"api_key"`
	Model       string `json:"model"`
	Active      *bool  `json:"active"`
	ClearAPIKey bool   `json:"clear_api_key"`
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
	// New entries default to becoming active when none is selected.
	makeActive := true
	if body.Active != nil {
		makeActive = *body.Active
	}
	reg, err := provider.UpsertEntry(r.Context(), s.Store, entry, makeActive)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
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
	// Empty/masked API key on update means "keep existing". clear_api_key forces wipe
	// after upsert by writing an empty secret explicitly.
	makeActive := false
	if body.Active != nil {
		makeActive = *body.Active
	}
	reg, err := provider.UpsertEntry(r.Context(), s.Store, entry, makeActive)
	if err == nil && body.ClearAPIKey {
		reg, err = provider.ClearEntryAPIKey(r.Context(), s.Store, id)
	}
	if err != nil {
		status := http.StatusBadRequest
		if isUnknownProvider(err) {
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, providersResponse{
		ActiveID:  reg.ActiveID,
		Providers: reg.Public(),
	})
}

func (s *Server) handleDeleteProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	reg, err := provider.DeleteEntry(r.Context(), s.Store, id)
	if err != nil {
		status := http.StatusBadRequest
		if isUnknownProvider(err) {
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, providersResponse{
		ActiveID:  reg.ActiveID,
		Providers: reg.Public(),
	})
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
	reg, err := provider.SetActive(r.Context(), s.Store, id)
	if err != nil {
		status := http.StatusBadRequest
		if isUnknownProvider(err) {
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
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

// syncRegistryFromLegacySettings upserts the active registry entry from the
// legacy single-slot provider.* settings keys. Used by PUT /api/settings so the
// older single-form UI still works alongside multi-provider management.
func syncRegistryFromLegacySettings(ctx context.Context, st *store.Store) error {
	get := func(k string) string {
		v, err := st.GetSetting(ctx, k)
		if err != nil {
			return ""
		}
		return v
	}
	cfg := provider.Config{
		Kind:    get(provider.KeyKind),
		BaseURL: get(provider.KeyBaseURL),
		APIKey:  get(provider.KeyAPIKey),
		Model:   get(provider.KeyModel),
	}.Normalize()

	reg, err := provider.LoadRegistry(ctx, st)
	if err != nil {
		return err
	}

	// Empty base_url disables the active provider by clearing its base/model,
	// or deleting the sole legacy entry when it came from migration.
	if !cfg.Configured() {
		if reg.ActiveID == "" {
			// Nothing configured either way.
			return provider.SaveRegistry(ctx, st, reg)
		}
		// Clear active entry credentials but keep the slot so the user can re-edit.
		if active, ok := reg.ByID(reg.ActiveID); ok {
			active.BaseURL = cfg.BaseURL
			active.Model = cfg.Model
			active.Kind = cfg.Kind
			active.APIKey = cfg.APIKey
			// If fully empty, delete the entry instead of leaving a broken one.
			if active.BaseURL == "" && active.Model == "" {
				_, err := provider.DeleteEntry(ctx, st, active.ID)
				return err
			}
			_, err := provider.UpsertEntry(ctx, st, active, true)
			return err
		}
		return nil
	}

	id := reg.ActiveID
	if id == "" {
		if len(reg.Entries) == 1 {
			id = reg.Entries[0].ID
		} else {
			id = "default"
		}
	}
	name := ""
	if prev, ok := reg.ByID(id); ok {
		name = prev.Name
		// Preserve key when legacy write omitted it (masked/empty path already handled).
		if cfg.APIKey == "" {
			cfg.APIKey = prev.APIKey
		}
	}
	entry := provider.Entry{
		ID:      id,
		Name:    name,
		Kind:    cfg.Kind,
		BaseURL: cfg.BaseURL,
		APIKey:  cfg.APIKey,
		Model:   cfg.Model,
	}
	_, err = provider.UpsertEntry(ctx, st, entry, true)
	return err
}
