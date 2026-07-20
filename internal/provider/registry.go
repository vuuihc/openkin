package provider

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/vuuihc/kin/internal/store"
)

// Registry settings keys. The registry is the multi-provider source of truth;
// legacy single-slot keys (KeyKind/KeyBaseURL/KeyAPIKey/KeyModel) are mirrored
// from the active entry so older readers keep working.
const (
	KeyProviders      = "providers"
	KeyActiveProvider = "provider.active_id"
)

// Entry is one registered cognition provider (OpenAI-compatible first).
type Entry struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	BaseURL string `json:"base_url"`
	APIKey  string `json:"api_key,omitempty"`
	Model   string `json:"model"`
	// Stream enables SSE transport for Chat (aggregated before return).
	Stream bool `json:"stream,omitempty"`
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

// Public returns masked entries for API responses, sorted by name then id.
func (r Registry) Public() []PublicEntry {
	r = r.Normalize()
	out := make([]PublicEntry, 0, len(r.Entries))
	for _, e := range r.Entries {
		out = append(out, PublicEntry{
			ID:      e.ID,
			Name:    e.Name,
			Kind:    e.Kind,
			BaseURL: e.BaseURL,
			APIKey:  MaskAPIKey(e.APIKey),
			Model:   e.Model,
			Stream:  e.Stream,
			Active:  e.ID == r.ActiveID,
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
// migrated in-memory (and, when Store is writable, persisted) into one entry.
func LoadRegistry(ctx context.Context, st *store.Store) (Registry, error) {
	if st == nil {
		return Registry{}, fmt.Errorf("store required")
	}
	raw, err := st.GetSetting(ctx, KeyProviders)
	if err != nil {
		raw = ""
	}
	activeID, _ := st.GetSetting(ctx, KeyActiveProvider)

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
		return reg, nil
	}

	// Legacy single-slot → one registry entry.
	legacy, err := loadLegacyConfig(ctx, st)
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
	// Persist migration so subsequent loads hit the registry path.
	if err := SaveRegistry(ctx, st, reg); err != nil {
		// Still return the in-memory registry so callers can use it.
		return reg, nil
	}
	return reg, nil
}

func loadLegacyConfig(ctx context.Context, st *store.Store) (Config, error) {
	get := func(k string) string {
		v, err := st.GetSetting(ctx, k)
		if err != nil {
			return ""
		}
		return v
	}
	return Config{
		Kind:    get(KeyKind),
		BaseURL: get(KeyBaseURL),
		APIKey:  get(KeyAPIKey),
		Model:   get(KeyModel),
		Stream:  parseBoolSetting(get(KeyStream)),
	}.Normalize(), nil
}

// SaveRegistry persists the registry and mirrors the active entry into the
// legacy single-slot keys (so LoadConfig / older UIs keep working).
func SaveRegistry(ctx context.Context, st *store.Store, reg Registry) error {
	if st == nil {
		return fmt.Errorf("store required")
	}
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
	// Store API keys as provided (unmasked). Callers must resolve masked keys
	// against the previous registry before calling SaveRegistry.
	b, err := json.Marshal(reg)
	if err != nil {
		return err
	}
	if err := st.SetSetting(ctx, KeyProviders, string(b)); err != nil {
		return err
	}
	if err := st.SetSetting(ctx, KeyActiveProvider, reg.ActiveID); err != nil {
		return err
	}
	// Mirror active → legacy keys.
	if active, ok := reg.Active(); ok {
		return SaveConfig(ctx, st, active.Config(), false)
	}
	// No active provider: clear legacy slot so Configured() is false.
	return SaveConfig(ctx, st, Config{Kind: "openai-compatible"}, true)
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
	return loadLegacyConfig(ctx, st)
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
	entry = entry.Normalize()
	if entry.ID == "" {
		entry.ID = newProviderID()
	}
	// Preserve API key when the client echoed a masked value or sent empty
	// without an explicit clear (clear is handled by ClearEntryAPIKey / empty
	// after dirty edit in the UI — empty here means "keep existing").
	if prev, ok := reg.ByID(entry.ID); ok {
		if entry.APIKey == "" || looksMasked(entry.APIKey) {
			entry.APIKey = prev.APIKey
		}
	} else if looksMasked(entry.APIKey) {
		entry.APIKey = ""
	}
	if err := entry.Validate(); err != nil {
		return Registry{}, err
	}

	found := false
	for i, e := range reg.Entries {
		if e.ID == entry.ID {
			reg.Entries[i] = entry
			found = true
			break
		}
	}
	if !found {
		reg.Entries = append(reg.Entries, entry)
	}
	if makeActive || reg.ActiveID == "" || (!found && len(reg.Entries) == 1) {
		reg.ActiveID = entry.ID
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
	id = strings.TrimSpace(id)
	if id == "" {
		return Registry{}, fmt.Errorf("provider id is required")
	}
	next := make([]Entry, 0, len(reg.Entries))
	found := false
	for _, e := range reg.Entries {
		if e.ID == id {
			found = true
			continue
		}
		next = append(next, e)
	}
	if !found {
		return Registry{}, fmt.Errorf("unknown provider id %q", id)
	}
	reg.Entries = next
	if reg.ActiveID == id {
		reg.ActiveID = ""
		if len(next) > 0 {
			reg.ActiveID = next[0].ID
		}
	}
	if err := SaveRegistry(ctx, st, reg); err != nil {
		return Registry{}, err
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
	for i, e := range reg.Entries {
		if e.ID == id {
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
	return reg, nil
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
