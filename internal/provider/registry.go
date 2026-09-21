package provider

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/vuuihc/openkin/internal/store"
)

// Registry settings keys. The registry is the multi-provider source of truth;
// legacy single-slot keys (KeyKind/KeyBaseURL/KeyAPIKey/KeyModel) are mirrored
// from the active entry so older readers keep working.
const (
	KeyProviders      = "providers"
	KeyActiveProvider = "provider.active_id"
)

// ModelSpec describes one model within a provider entry, tagged with tier
// and cost label for routing decisions.
type ModelSpec struct {
	ID        string `json:"id"`
	Tier      string `json:"tier"`       // smart | balanced | fast | free
	CostLabel string `json:"cost_label"` // paid | company | free | unknown
}

// Entry is one registered cognition provider (OpenAI-compatible first).
// Routing fields (SupportsAgents, Models) are stored alongside runtime config
// so there is a single source of truth for all provider configuration.
type Entry struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	BaseURL string `json:"base_url"`
	APIKey  string `json:"api_key,omitempty"`
	Model   string `json:"model"`
	// Stream enables SSE transport for Chat (aggregated before return).
	Stream bool `json:"stream,omitempty"`
	// Routing fields: agents this provider supports and the model list with
	// tier/cost metadata for auto model routing decisions.
	SupportsAgents []string    `json:"supports_agents,omitempty"`
	Models         []ModelSpec `json:"models,omitempty"`
	// Enabled controls whether this provider participates in routing.
	Enabled *bool `json:"enabled,omitempty"`
}

// PublicEntry is Entry with a masked API key for GET responses.
type PublicEntry struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	BaseURL string `json:"base_url"`
	APIKey  string `json:"api_key,omitempty"`
	Model   string `json:"model"`
	Stream  bool   `json:"stream"`
	Active  bool   `json:"active"`
	// Routing fields (included so the UI can manage them).
	SupportsAgents []string    `json:"supports_agents,omitempty"`
	Models         []ModelSpec `json:"models,omitempty"`
	Enabled        *bool       `json:"enabled,omitempty"`
}

// Registry is the persisted multi-provider list plus the active id.
type Registry struct {
	ActiveID string  `json:"active_id"`
	Entries  []Entry `json:"entries"`
}

// Normalize trims fields and fills defaults on every entry.
func (r Registry) Normalize() Registry {
	r.ActiveID = strings.TrimSpace(r.ActiveID)
	out := make([]Entry, 0, len(r.Entries))
	for _, e := range r.Entries {
		e = e.Normalize()
		if e.ID == "" {
			continue
		}
		out = append(out, e)
	}
	r.Entries = out
	return r
}

// Normalize trims and defaults one entry.
func (e Entry) Normalize() Entry {
	e.ID = strings.TrimSpace(e.ID)
	e.Name = strings.TrimSpace(e.Name)
	e.Kind = strings.TrimSpace(e.Kind)
	if e.Kind == "" {
		e.Kind = "openai-compatible"
	}
	e.BaseURL = strings.TrimRight(strings.TrimSpace(e.BaseURL), "/")
	e.APIKey = strings.TrimSpace(e.APIKey)
	e.Model = strings.TrimSpace(e.Model)
	if e.Name == "" {
		e.Name = defaultEntryName(e)
	}
	// Normalize routing model specs.
	normModels := make([]ModelSpec, 0, len(e.Models))
	for _, m := range e.Models {
		m.ID = strings.TrimSpace(m.ID)
		if m.ID == "" {
			continue
		}
		normModels = append(normModels, m)
	}
	e.Models = normModels
	// Deduplicate supports_agents.
	seen := make(map[string]bool, len(e.SupportsAgents))
	uniq := make([]string, 0, len(e.SupportsAgents))
	for _, a := range e.SupportsAgents {
		a = strings.TrimSpace(a)
		if a == "" || seen[a] {
			continue
		}
		seen[a] = true
		uniq = append(uniq, a)
	}
	e.SupportsAgents = uniq
	return e
}

func defaultEntryName(e Entry) string {
	if e.Model != "" {
		return e.Model
	}
	if e.BaseURL != "" {
		return e.BaseURL
	}
	return e.ID
}

// Config converts an entry to the runtime Config used by NewClient.
func (e Entry) Config() Config {
	return Config{
		Kind:    e.Kind,
		BaseURL: e.BaseURL,
		APIKey:  e.APIKey,
		Model:   e.Model,
		Stream:  e.Stream,
	}.Normalize()
}

// Validate checks an entry is usable as a provider.
func (e Entry) Validate() error {
	if strings.TrimSpace(e.ID) == "" {
		return fmt.Errorf("provider id is required")
	}
	return e.Config().Validate()
}

// Active returns the active entry, or ok=false when none is selected/configured.
func (r Registry) Active() (Entry, bool) {
	r = r.Normalize()
	if r.ActiveID == "" || len(r.Entries) == 0 {
		return Entry{}, false
	}
	for _, e := range r.Entries {
		if e.ID == r.ActiveID {
			return e, true
		}
	}
	return Entry{}, false
}

// ByID returns an entry by id.
func (r Registry) ByID(id string) (Entry, bool) {
	id = strings.TrimSpace(id)
	for _, e := range r.Entries {
		if e.ID == id {
			return e, true
		}
	}
	return Entry{}, false
}

// WithEntry returns a registry with entry inserted or replaced.
func (r Registry) WithEntry(entry Entry, makeActive bool) (Registry, error) {
	r = r.Normalize()
	entry = entry.Normalize()
	if entry.ID == "" {
		entry.ID = newProviderID()
	}
	if previous, ok := r.ByID(entry.ID); ok {
		if entry.APIKey == "" || looksMasked(entry.APIKey) {
			entry.APIKey = previous.APIKey
		}
	} else if looksMasked(entry.APIKey) {
		entry.APIKey = ""
	}
	if err := entry.Validate(); err != nil {
		return Registry{}, err
	}
	found := false
	for i := range r.Entries {
		if r.Entries[i].ID == entry.ID {
			r.Entries[i] = entry
			found = true
			break
		}
	}
	if !found {
		r.Entries = append(r.Entries, entry)
	}
	if makeActive || r.ActiveID == "" || (!found && len(r.Entries) == 1) {
		r.ActiveID = entry.ID
	}
	return r, nil
}

// WithoutEntry returns a registry without id.
func (r Registry) WithoutEntry(id string) (Registry, error) {
	r = r.Normalize()
	id = strings.TrimSpace(id)
	if id == "" {
		return Registry{}, fmt.Errorf("provider id is required")
	}
	next := make([]Entry, 0, len(r.Entries))
	found := false
	for _, entry := range r.Entries {
		if entry.ID == id {
			found = true
			continue
		}
		next = append(next, entry)
	}
	if !found {
		return Registry{}, fmt.Errorf("unknown provider id %q", id)
	}
	r.Entries = next
	if r.ActiveID == id {
		r.ActiveID = ""
		if len(next) > 0 {
			r.ActiveID = next[0].ID
		}
	}
	return r, nil
}

// Public returns masked entries for API responses, sorted by name then id.
func (r Registry) Public() []PublicEntry {
	r = r.Normalize()
	out := make([]PublicEntry, 0, len(r.Entries))
	for _, e := range r.Entries {
		out = append(out, PublicEntry{
			ID:             e.ID,
			Name:           e.Name,
			Kind:           e.Kind,
			BaseURL:        e.BaseURL,
			APIKey:         MaskAPIKey(e.APIKey),
			Model:          e.Model,
			Stream:         e.Stream,
			Active:         e.ID == r.ActiveID,
			SupportsAgents: e.SupportsAgents,
			Models:         e.Models,
			Enabled:        e.Enabled,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// LoadRegistry reads the multi-provider registry.
// If the registry key is empty but a legacy single-slot config exists, it is
// migrated and persisted into one entry.
func LoadRegistry(ctx context.Context, st *store.Store) (Registry, error) {
	return loadRegistry(ctx, st, true)
}

// LoadRegistryMetadata reads provider metadata for API display without
// hydrating secret:// API keys. Use LoadRegistry for runtime provider execution.
func LoadRegistryMetadata(ctx context.Context, st *store.Store) (Registry, error) {
	return loadRegistry(ctx, st, false)
}

func loadRegistry(ctx context.Context, st *store.Store, hydrateSecrets bool) (Registry, error) {
	if st == nil {
		return Registry{}, fmt.Errorf("store required")
	}
	raw, err := st.GetSetting(ctx, KeyProviders)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			return Registry{}, fmt.Errorf("load providers: %w", err)
		}
		raw = ""
	}
	activeID, err := st.GetSetting(ctx, KeyActiveProvider)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			return Registry{}, fmt.Errorf("load active provider: %w", err)
		}
		activeID = ""
	}

	var reg Registry
	if strings.TrimSpace(raw) != "" {
		if err := json.Unmarshal([]byte(raw), &reg); err != nil {
			return Registry{}, fmt.Errorf("parse providers: %w", err)
		}
		// Active id may live outside the JSON blob (settings key).
		if strings.TrimSpace(activeID) != "" {
			reg.ActiveID = strings.TrimSpace(activeID)
		}
		reg = reg.Normalize()
		// Drop broken active pointers.
		if reg.ActiveID != "" {
			if _, ok := reg.ByID(reg.ActiveID); !ok {
				reg.ActiveID = ""
			}
		}
		if reg.ActiveID == "" && len(reg.Entries) > 0 {
			reg.ActiveID = reg.Entries[0].ID
		}
		if !hydrateSecrets {
			return reg, nil
		}
		var changed bool
		for i := range reg.Entries {
			key, err := hydrateAPIKey(reg.Entries[i].APIKey)
			if err != nil {
				return Registry{}, fmt.Errorf("load provider secret: %w", err)
			}
			if key != reg.Entries[i].APIKey {
				reg.Entries[i].APIKey = key
				changed = true
			}
			if secretStore() != nil && reg.Entries[i].APIKey != "" &&
				!isSecretReference(reg.Entries[i].APIKey) {
				changed = true
			}
		}
		if changed && secretStore() != nil {
			if err := SaveRegistry(ctx, st, reg); err != nil {
				return Registry{}, fmt.Errorf("persist provider secret migration: %w", err)
			}
		}
		return reg, nil
	}

	// Legacy single-slot → one registry entry.
	legacy, err := loadLegacyConfig(ctx, st, hydrateSecrets)
	if err != nil {
		return Registry{}, err
	}
	if !legacy.Configured() {
		return Registry{ActiveID: strings.TrimSpace(activeID)}.Normalize(), nil
	}
	id := "legacy"
	entry := Entry{
		ID:      id,
		Name:    defaultEntryName(Entry{Model: legacy.Model, BaseURL: legacy.BaseURL, ID: id}),
		Kind:    legacy.Kind,
		BaseURL: legacy.BaseURL,
		APIKey:  legacy.APIKey,
		Model:   legacy.Model,
		Stream:  legacy.Stream,
	}.Normalize()
	reg = Registry{ActiveID: id, Entries: []Entry{entry}}.Normalize()
	if !hydrateSecrets {
		return reg, nil
	}
	// Persist migration so subsequent loads hit the registry path.
	if err := SaveRegistry(ctx, st, reg); err != nil {
		return Registry{}, fmt.Errorf("persist legacy provider migration: %w", err)
	}
	return reg, nil
}

func loadLegacyConfig(ctx context.Context, st *store.Store, hydrateSecret bool) (Config, error) {
	get := func(k string) (string, error) {
		v, err := st.GetSetting(ctx, k)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return "", nil
			}
			return "", err
		}
		return v, nil
	}
	kind, err := get(KeyKind)
	if err != nil {
		return Config{}, fmt.Errorf("load %s: %w", KeyKind, err)
	}
	baseURL, err := get(KeyBaseURL)
	if err != nil {
		return Config{}, fmt.Errorf("load %s: %w", KeyBaseURL, err)
	}
	apiKey, err := get(KeyAPIKey)
	if err != nil {
		return Config{}, fmt.Errorf("load %s: %w", KeyAPIKey, err)
	}
	model, err := get(KeyModel)
	if err != nil {
		return Config{}, fmt.Errorf("load %s: %w", KeyModel, err)
	}
	stream, err := get(KeyStream)
	if err != nil {
		return Config{}, fmt.Errorf("load %s: %w", KeyStream, err)
	}
	if hydrateSecret {
		apiKey, err = hydrateAPIKey(apiKey)
		if err != nil {
			return Config{}, fmt.Errorf("load provider secret: %w", err)
		}
	}
	return Config{
		Kind:    kind,
		BaseURL: baseURL,
		APIKey:  apiKey,
		Model:   model,
		Stream:  parseBoolSetting(stream),
	}.Normalize(), nil
}

// SaveRegistry persists the registry and mirrors the active entry into the
// legacy single-slot keys (so LoadConfig / older UIs keep working).
func SaveRegistry(ctx context.Context, st *store.Store, reg Registry) error {
	if st == nil {
		return fmt.Errorf("store required")
	}
	values, err := RegistrySettings(reg)
	if err != nil {
		return err
	}
	return st.SetSettings(ctx, values)
}

// RegistrySettings serializes the registry and its active legacy mirror for a
// single atomic settings write.
func RegistrySettings(reg Registry) (map[string]string, error) {
	reg = reg.Normalize()
	// Ensure active id is valid or clear it.
	if reg.ActiveID != "" {
		if _, ok := reg.ByID(reg.ActiveID); !ok {
			reg.ActiveID = ""
		}
	}
	if reg.ActiveID == "" && len(reg.Entries) > 0 {
		reg.ActiveID = reg.Entries[0].ID
	}
	for i := range reg.Entries {
		key, _, err := externalizeAPIKey(reg.Entries[i].ID, reg.Entries[i].APIKey)
		if err != nil {
			return nil, fmt.Errorf("store provider secret: %w", err)
		}
		reg.Entries[i].APIKey = key
	}
	// Store API keys as provided (unmasked). Callers must resolve masked keys
	// against the previous registry before calling SaveRegistry.
	b, err := json.Marshal(reg)
	if err != nil {
		return nil, err
	}
	values := map[string]string{
		KeyProviders:      string(b),
		KeyActiveProvider: reg.ActiveID,
	}
	// Mirror active → legacy keys.
	if active, ok := reg.Active(); ok {
		cfg := active.Config()
		values[KeyKind] = cfg.Kind
		values[KeyBaseURL] = cfg.BaseURL
		values[KeyAPIKey] = cfg.APIKey
		values[KeyModel] = cfg.Model
		values[KeyStream] = formatBoolSetting(cfg.Stream)
	} else {
		// No active provider: clear legacy slot so Configured() is false.
		values[KeyKind] = "openai-compatible"
		values[KeyBaseURL] = ""
		values[KeyAPIKey] = ""
		values[KeyModel] = ""
		values[KeyStream] = "false"
	}
	return values, nil
}

// LoadConfig reads the active provider as a Config.
// Prefer LoadRegistry when the multi-provider list is needed.
func LoadConfig(ctx context.Context, st *store.Store) (Config, error) {
	reg, err := LoadRegistry(ctx, st)
	if err != nil {
		return Config{}, err
	}
	if active, ok := reg.Active(); ok {
		return active.Config(), nil
	}
	// Fall back to legacy keys if registry is empty but slot still set
	// (e.g. concurrent write mid-migration).
	return loadLegacyConfig(ctx, st, true)
}

// SetActive switches the active provider id and mirrors legacy keys.
func SetActive(ctx context.Context, st *store.Store, id string) (Registry, error) {
	reg, err := LoadRegistry(ctx, st)
	if err != nil {
		return Registry{}, err
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return Registry{}, fmt.Errorf("provider id is required")
	}
	if _, ok := reg.ByID(id); !ok {
		return Registry{}, fmt.Errorf("unknown provider id %q", id)
	}
	reg.ActiveID = id
	if err := SaveRegistry(ctx, st, reg); err != nil {
		return Registry{}, err
	}
	return reg, nil
}

// UpsertEntry creates or updates a provider entry.
// If APIKey looks masked, the previous key for that id is preserved.
// When makeActive is true (or this is the first entry), the entry becomes active.
func UpsertEntry(ctx context.Context, st *store.Store, entry Entry, makeActive bool) (Registry, error) {
	reg, err := LoadRegistry(ctx, st)
	if err != nil {
		return Registry{}, err
	}
	reg, err = reg.WithEntry(entry, makeActive)
	if err != nil {
		return Registry{}, err
	}
	if err := SaveRegistry(ctx, st, reg); err != nil {
		return Registry{}, err
	}
	return reg, nil
}

// DeleteEntry removes a provider. If it was active, the first remaining entry
// becomes active (or the active slot is cleared).
func DeleteEntry(ctx context.Context, st *store.Store, id string) (Registry, error) {
	reg, err := LoadRegistry(ctx, st)
	if err != nil {
		return Registry{}, err
	}
	var oldKey string
	for _, entry := range reg.Entries {
		if entry.ID == id {
			oldKey = entry.APIKey
			break
		}
	}
	reg, err = reg.WithoutEntry(id)
	if err != nil {
		return Registry{}, err
	}
	if err := SaveRegistry(ctx, st, reg); err != nil {
		return Registry{}, err
	}
	if err := DeleteEntrySecret(id, oldKey); err != nil {
		return Registry{}, fmt.Errorf("delete provider secret: %w", err)
	}
	return reg, nil
}

// ClearEntryAPIKey removes the API key for one entry and re-saves.
func ClearEntryAPIKey(ctx context.Context, st *store.Store, id string) (Registry, error) {
	reg, err := LoadRegistry(ctx, st)
	if err != nil {
		return Registry{}, err
	}
	id = strings.TrimSpace(id)
	found := false
	var oldKey string
	for i, e := range reg.Entries {
		if e.ID == id {
			oldKey = e.APIKey
			e.APIKey = ""
			reg.Entries[i] = e
			found = true
			break
		}
	}
	if !found {
		return Registry{}, fmt.Errorf("unknown provider id %q", id)
	}
	if err := SaveRegistry(ctx, st, reg); err != nil {
		return Registry{}, err
	}
	if err := DeleteEntrySecret(id, oldKey); err != nil {
		return Registry{}, fmt.Errorf("delete provider secret: %w", err)
	}
	return reg, nil
}

// DeleteEntrySecret removes the stored secret for a provider entry.
// oldKey may be a stored secret:// reference, a hydrated plaintext key, or empty
// for legacy callers that only know the canonical provider id.
func DeleteEntrySecret(id, oldKey string) error {
	secrets := secretStore()
	if secrets == nil {
		return nil
	}
	ref := secretReference(id)
	if isSecretReference(oldKey) {
		ref = strings.TrimPrefix(oldKey, "secret://")
	}
	return secrets.Delete(ref)
}

func newProviderID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		// Extremely unlikely; fall back to time-based hex.
		return fmt.Sprintf("p_%d", time.Now().UnixNano())
	}
	return "p_" + hex.EncodeToString(b[:])
}

func parseBoolSetting(v string) bool {
	switch strings.TrimSpace(strings.ToLower(v)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func formatBoolSetting(v bool) string {
	if v {
		return "true"
	}
	return "false"
}
