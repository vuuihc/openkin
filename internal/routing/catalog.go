package routing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/vuuihc/openkin/internal/provider"
	"github.com/vuuihc/openkin/internal/store"
)

const (
	keyProfiles = "routing.profiles"
	keyDefaults = "routing.defaults"
)

// ErrInvalidConfig marks caller-supplied routing configuration that violates
// domain invariants. Storage and decoding failures intentionally do not wrap it.
var ErrInvalidConfig = errors.New("invalid routing configuration")

var catalogWriteMu sync.Mutex

// Catalog owns persisted routing and provider configuration as domain values.
// Callers do not need to know settings keys, JSON shapes, or provider registry
// compatibility rules.
type Catalog struct {
	store       *store.Store
	agentExists func(string) bool
}

// NewCatalog creates a routing/provider configuration catalog.
func NewCatalog(st *store.Store, agentExists func(string) bool) *Catalog {
	return &Catalog{store: st, agentExists: agentExists}
}

// ListProviderProfiles returns provider registry entries in routing form.
func (c *Catalog) ListProviderProfiles(ctx context.Context) ([]ProviderProfile, error) {
	reg, err := provider.LoadRegistry(ctx, c.store)
	if err != nil {
		return nil, fmt.Errorf("load provider profiles: %w", err)
	}
	return providerProfilesFromRegistry(reg), nil
}

// SaveProviderProfiles validates and persists routing fields in the provider
// registry without discarding runtime credentials or transport settings.
func (c *Catalog) SaveProviderProfiles(ctx context.Context, profiles []ProviderProfile) error {
	catalogWriteMu.Lock()
	defer catalogWriteMu.Unlock()

	seen := make(map[string]bool, len(profiles))
	for _, profile := range profiles {
		if err := ValidateProviderProfile(profile); err != nil {
			return fmt.Errorf("%w: %v", ErrInvalidConfig, err)
		}
		if seen[profile.ID] {
			return fmt.Errorf("%w: duplicate provider profile id %q", ErrInvalidConfig, profile.ID)
		}
		seen[profile.ID] = true
	}

	reg, err := provider.LoadRegistry(ctx, c.store)
	if err != nil {
		return fmt.Errorf("load provider registry: %w", err)
	}
	for _, profile := range profiles {
		entry, found := reg.ByID(profile.ID)
		if !found {
			entry.ID = profile.ID
		}
		entry.Name = profile.Name
		entry.Kind = string(profile.Kind)
		entry.SupportsAgents = append([]string(nil), profile.SupportsAgents...)
		entry.Models = providerModels(profile.Models)
		enabled := profile.Enabled
		entry.Enabled = &enabled

		if found {
			for i := range reg.Entries {
				if reg.Entries[i].ID == profile.ID {
					reg.Entries[i] = entry.Normalize()
					break
				}
			}
		} else {
			reg.Entries = append(reg.Entries, entry.Normalize())
		}
	}
	proposedProviders := providerProfilesFromRegistry(reg)
	teams, err := c.loadTeamProfiles(ctx)
	if err != nil {
		return err
	}
	if err := c.validateTeamsWithProviders(teams, proposedProviders); err != nil {
		return fmt.Errorf("%w: provider update invalidates team profiles: %v", ErrInvalidConfig, err)
	}
	if err := provider.SaveRegistry(ctx, c.store, reg); err != nil {
		return fmt.Errorf("save provider profiles: %w", err)
	}
	return nil
}

// UpsertProvider writes runtime provider fields while preserving routing
// metadata and validating the resulting routing graph.
func (c *Catalog) UpsertProvider(
	ctx context.Context,
	entry provider.Entry,
	makeActive, clearAPIKey, preserveStream bool,
) (provider.Registry, error) {
	catalogWriteMu.Lock()
	defer catalogWriteMu.Unlock()

	reg, err := provider.LoadRegistry(ctx, c.store)
	if err != nil {
		return provider.Registry{}, err
	}
	if previous, ok := reg.ByID(entry.ID); ok {
		entry.SupportsAgents = append([]string(nil), previous.SupportsAgents...)
		entry.Models = append([]provider.ModelSpec(nil), previous.Models...)
		entry.Enabled = previous.Enabled
		if preserveStream {
			entry.Stream = previous.Stream
		}
		if clearAPIKey {
			entry.APIKey = ""
		}
	}
	reg, err = reg.WithEntry(entry, makeActive)
	if err != nil {
		return provider.Registry{}, fmt.Errorf("%w: %v", ErrInvalidConfig, err)
	}
	if clearAPIKey {
		for i := range reg.Entries {
			if reg.Entries[i].ID == entry.ID {
				reg.Entries[i].APIKey = ""
				break
			}
		}
	}
	if err := c.validateProviderGraph(ctx, reg); err != nil {
		return provider.Registry{}, err
	}
	if err := provider.SaveRegistry(ctx, c.store, reg); err != nil {
		return provider.Registry{}, err
	}
	return reg, nil
}

// DeleteProvider removes a provider only when no persisted team depends on it.
func (c *Catalog) DeleteProvider(ctx context.Context, id string) (provider.Registry, error) {
	catalogWriteMu.Lock()
	defer catalogWriteMu.Unlock()

	if strings.TrimSpace(id) == "" {
		return provider.Registry{}, fmt.Errorf("%w: provider id is required", ErrInvalidConfig)
	}
	reg, err := provider.LoadRegistry(ctx, c.store)
	if err != nil {
		return provider.Registry{}, err
	}
	reg, err = reg.WithoutEntry(id)
	if err != nil {
		return provider.Registry{}, err
	}
	if err := c.validateProviderGraph(ctx, reg); err != nil {
		return provider.Registry{}, err
	}
	return provider.DeleteEntry(ctx, c.store, id)
}

// SetActiveProvider changes the active runtime provider under the catalog write lock.
func (c *Catalog) SetActiveProvider(ctx context.Context, id string) (provider.Registry, error) {
	catalogWriteMu.Lock()
	defer catalogWriteMu.Unlock()
	id = strings.TrimSpace(id)
	if id == "" {
		return provider.Registry{}, fmt.Errorf("%w: provider id is required", ErrInvalidConfig)
	}
	reg, err := provider.LoadRegistry(ctx, c.store)
	if err != nil {
		return provider.Registry{}, err
	}
	entry, ok := reg.ByID(id)
	if !ok {
		return provider.Registry{}, fmt.Errorf("unknown provider id %q", id)
	}
	cfg := entry.Config()
	if !cfg.Configured() {
		return provider.Registry{}, fmt.Errorf(
			"%w: provider %q is not configured for runtime use", ErrInvalidConfig, id,
		)
	}
	if err := cfg.Validate(); err != nil {
		return provider.Registry{}, fmt.Errorf("%w: provider %q: %v", ErrInvalidConfig, id, err)
	}
	reg.ActiveID = id
	if err := provider.SaveRegistry(ctx, c.store, reg); err != nil {
		return provider.Registry{}, err
	}
	return reg, nil
}

// SaveSettingsWithLegacyProvider applies a validated settings request while
// keeping the active provider registry and legacy provider.* mirror atomic.
func (c *Catalog) SaveSettingsWithLegacyProvider(
	ctx context.Context,
	values map[string]string,
	clearAPIKey bool,
) error {
	catalogWriteMu.Lock()
	defer catalogWriteMu.Unlock()

	reg, err := provider.LoadRegistry(ctx, c.store)
	if err != nil {
		return err
	}
	cfg := provider.Config{Kind: "openai-compatible"}
	active, hasActive := reg.Active()
	if hasActive {
		cfg = active.Config()
	} else {
		cfg, err = loadLegacyProviderConfig(ctx, c.store)
		if err != nil {
			return err
		}
	}
	if value, ok := values[provider.KeyKind]; ok {
		cfg.Kind = value
	}
	if value, ok := values[provider.KeyBaseURL]; ok {
		cfg.BaseURL = value
	}
	if value, ok := values[provider.KeyModel]; ok {
		cfg.Model = value
	}
	if value, ok := values[provider.KeyStream]; ok {
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "1", "true", "yes", "on":
			cfg.Stream = true
		default:
			cfg.Stream = false
		}
	}
	if clearAPIKey {
		cfg.APIKey = ""
	} else if value, ok := values[provider.KeyAPIKey]; ok &&
		strings.TrimSpace(value) != "" && !provider.LooksMaskedAPIKey(value) {
		cfg.APIKey = value
	}
	cfg = cfg.Normalize()

	registryChanged := false
	switch {
	case cfg.Configured():
		id := reg.ActiveID
		if id == "" {
			if len(reg.Entries) == 1 {
				id = reg.Entries[0].ID
			} else {
				id = "default"
			}
		}
		entry, found := reg.ByID(id)
		if !found {
			entry.ID = id
		}
		entry.Kind = cfg.Kind
		entry.BaseURL = cfg.BaseURL
		entry.APIKey = cfg.APIKey
		entry.Model = cfg.Model
		entry.Stream = cfg.Stream
		reg, err = reg.WithEntry(entry, true)
		if err != nil {
			return fmt.Errorf("%w: %v", ErrInvalidConfig, err)
		}
		if clearAPIKey {
			for i := range reg.Entries {
				if reg.Entries[i].ID == id {
					reg.Entries[i].APIKey = ""
					break
				}
			}
		}
		registryChanged = true
	case hasActive && cfg.BaseURL == "" && cfg.Model == "":
		reg, err = reg.WithoutEntry(active.ID)
		if err != nil {
			return err
		}
		registryChanged = true
	case hasActive:
		if err := cfg.Validate(); err != nil {
			return fmt.Errorf("%w: %v", ErrInvalidConfig, err)
		}
	}

	next := make(map[string]string, len(values)+7)
	for key, value := range values {
		next[key] = value
	}
	if registryChanged {
		if err := c.validateProviderGraph(ctx, reg); err != nil {
			return err
		}
		providerValues, err := provider.RegistrySettings(reg)
		if err != nil {
			return fmt.Errorf("encode provider registry: %w", err)
		}
		for key, value := range providerValues {
			next[key] = value
		}
	} else {
		next[provider.KeyKind] = cfg.Kind
		next[provider.KeyBaseURL] = cfg.BaseURL
		next[provider.KeyModel] = cfg.Model
		if cfg.Stream {
			next[provider.KeyStream] = "true"
		} else {
			next[provider.KeyStream] = "false"
		}
		if clearAPIKey {
			next[provider.KeyAPIKey] = ""
		} else if value, ok := next[provider.KeyAPIKey]; !ok ||
			strings.TrimSpace(value) == "" || provider.LooksMaskedAPIKey(value) {
			delete(next, provider.KeyAPIKey)
		}
	}
	if err := c.store.SetSettings(ctx, next); err != nil {
		return fmt.Errorf("save settings: %w", err)
	}
	return nil
}

// ListTeamProfiles loads and validates all persisted team profiles.
func (c *Catalog) ListTeamProfiles(ctx context.Context) ([]TeamProfile, error) {
	profiles, err := c.loadTeamProfiles(ctx)
	if err != nil {
		return nil, err
	}
	if err := c.validateTeams(ctx, profiles); err != nil {
		return nil, fmt.Errorf("validate persisted routing profiles: %w", err)
	}
	return profiles, nil
}

// SaveTeamProfiles validates and persists the complete team profile list.
func (c *Catalog) SaveTeamProfiles(ctx context.Context, profiles []TeamProfile) error {
	catalogWriteMu.Lock()
	defer catalogWriteMu.Unlock()

	if err := c.validateTeams(ctx, profiles); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidConfig, err)
	}
	if profiles == nil {
		profiles = []TeamProfile{}
	}
	var defaults RoutingDefaults
	if found, err := c.loadJSON(ctx, keyDefaults, &defaults); err != nil {
		return err
	} else if found {
		if err := ValidateRoutingDefaults(defaults, teamExists(profiles)); err != nil {
			return fmt.Errorf("%w: team update invalidates routing defaults: %v", ErrInvalidConfig, err)
		}
	}
	return c.saveJSON(ctx, keyProfiles, TeamProfileList{Profiles: profiles})
}

// GetRoutingDefaults returns validated persisted defaults or the domain defaults.
func (c *Catalog) GetRoutingDefaults(ctx context.Context) (RoutingDefaults, error) {
	var defaults RoutingDefaults
	found, err := c.loadJSON(ctx, keyDefaults, &defaults)
	if err != nil {
		return RoutingDefaults{}, err
	}
	if !found {
		return DefaultRoutingDefaults(), nil
	}
	teams, err := c.ListTeamProfiles(ctx)
	if err != nil {
		return RoutingDefaults{}, err
	}
	if err := ValidateRoutingDefaults(defaults, teamExists(teams)); err != nil {
		return RoutingDefaults{}, fmt.Errorf("validate persisted routing defaults: %w", err)
	}
	return defaults, nil
}

// SaveRoutingDefaults validates and persists routing defaults.
func (c *Catalog) SaveRoutingDefaults(ctx context.Context, defaults RoutingDefaults) error {
	catalogWriteMu.Lock()
	defer catalogWriteMu.Unlock()

	teams, err := c.ListTeamProfiles(ctx)
	if err != nil {
		return err
	}
	if err := ValidateRoutingDefaults(defaults, teamExists(teams)); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidConfig, err)
	}
	return c.saveJSON(ctx, keyDefaults, defaults)
}

// ModelsForAgent returns enabled configured model overlays for one agent and
// provider kind.
func (c *Catalog) ModelsForAgent(ctx context.Context, agentID string, kind ProviderKind) ([]ModelSpec, error) {
	profiles, err := c.ListProviderProfiles(ctx)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool)
	var models []ModelSpec
	for _, profile := range profiles {
		if !profile.Enabled || profile.Kind != kind || !supportsAgent(profile.SupportsAgents, agentID) {
			continue
		}
		for _, model := range profile.Models {
			id := strings.TrimSpace(model.ID)
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			model.ID = id
			models = append(models, model)
		}
	}
	return models, nil
}

func (c *Catalog) validateTeams(ctx context.Context, profiles []TeamProfile) error {
	providers, err := c.ListProviderProfiles(ctx)
	if err != nil {
		return err
	}
	return c.validateTeamsWithProviders(profiles, providers)
}

func (c *Catalog) validateTeamsWithProviders(profiles []TeamProfile, providers []ProviderProfile) error {
	providerExists := func(id string) bool {
		for _, profile := range providers {
			if profile.ID == id {
				return true
			}
		}
		return false
	}
	seenIDs := make(map[string]bool, len(profiles))
	for _, profile := range profiles {
		if seenIDs[profile.ID] {
			return fmt.Errorf("duplicate team profile id %q", profile.ID)
		}
		seenIDs[profile.ID] = true
		if err := ValidateTeamProfile(profile, c.agentExists, providerExists, providers); err != nil {
			return err
		}
		if profile.Alias != "" {
			if conflict := CheckAliasConflict(profile.Alias, profile.ID, profiles); conflict != "" {
				return fmt.Errorf("alias %s conflicts with team %s", profile.Alias, conflict)
			}
		}
	}
	return nil
}

func (c *Catalog) validateProviderGraph(ctx context.Context, reg provider.Registry) error {
	teams, err := c.loadTeamProfiles(ctx)
	if err != nil {
		return err
	}
	if err := c.validateTeamsWithProviders(teams, providerProfilesFromRegistry(reg)); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidConfig, err)
	}
	return nil
}

func loadLegacyProviderConfig(ctx context.Context, st *store.Store) (provider.Config, error) {
	read := func(key string) (string, error) {
		value, err := st.GetSetting(ctx, key)
		if errors.Is(err, store.ErrNotFound) {
			return "", nil
		}
		if err != nil {
			return "", fmt.Errorf("load %s: %w", key, err)
		}
		return value, nil
	}
	kind, err := read(provider.KeyKind)
	if err != nil {
		return provider.Config{}, err
	}
	baseURL, err := read(provider.KeyBaseURL)
	if err != nil {
		return provider.Config{}, err
	}
	apiKey, err := read(provider.KeyAPIKey)
	if err != nil {
		return provider.Config{}, err
	}
	model, err := read(provider.KeyModel)
	if err != nil {
		return provider.Config{}, err
	}
	stream, err := read(provider.KeyStream)
	if err != nil {
		return provider.Config{}, err
	}
	switch strings.ToLower(strings.TrimSpace(stream)) {
	case "1", "true", "yes", "on":
		stream = "true"
	default:
		stream = "false"
	}
	return provider.Config{
		Kind:    kind,
		BaseURL: baseURL,
		APIKey:  apiKey,
		Model:   model,
		Stream:  stream == "true",
	}.Normalize(), nil
}

func (c *Catalog) loadTeamProfiles(ctx context.Context) ([]TeamProfile, error) {
	var list TeamProfileList
	found, err := c.loadJSON(ctx, keyProfiles, &list)
	if err != nil {
		return nil, err
	}
	if !found || list.Profiles == nil {
		return []TeamProfile{}, nil
	}
	return list.Profiles, nil
}

func (c *Catalog) loadJSON(ctx context.Context, key string, dst any) (bool, error) {
	if c == nil || c.store == nil {
		return false, fmt.Errorf("routing catalog store required")
	}
	raw, err := c.store.GetSetting(ctx, key)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return false, nil
		}
		return false, fmt.Errorf("load %s: %w", key, err)
	}
	if strings.TrimSpace(raw) == "" {
		return false, nil
	}
	if err := json.Unmarshal([]byte(raw), dst); err != nil {
		return false, fmt.Errorf("parse %s: %w", key, err)
	}
	return true, nil
}

func (c *Catalog) saveJSON(ctx context.Context, key string, value any) error {
	if c == nil || c.store == nil {
		return fmt.Errorf("routing catalog store required")
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode %s: %w", key, err)
	}
	if err := c.store.SetSetting(ctx, key, string(raw)); err != nil {
		return fmt.Errorf("save %s: %w", key, err)
	}
	return nil
}

func providerProfilesFromRegistry(reg provider.Registry) []ProviderProfile {
	profiles := make([]ProviderProfile, 0, len(reg.Entries))
	for _, entry := range reg.Entries {
		enabled := true
		if entry.Enabled != nil {
			enabled = *entry.Enabled
		}
		profiles = append(profiles, ProviderProfile{
			ID:             entry.ID,
			Name:           entry.Name,
			Kind:           ProviderKind(entry.Kind),
			SupportsAgents: append([]string(nil), entry.SupportsAgents...),
			Enabled:        enabled,
			Models:         routingModels(entry.Models),
		})
	}
	return profiles
}

func providerModels(models []ModelSpec) []provider.ModelSpec {
	out := make([]provider.ModelSpec, len(models))
	for i, model := range models {
		out[i] = provider.ModelSpec{ID: model.ID, Tier: model.Tier, CostLabel: model.CostLabel}
	}
	return out
}

func routingModels(models []provider.ModelSpec) []ModelSpec {
	out := make([]ModelSpec, len(models))
	for i, model := range models {
		out[i] = ModelSpec{ID: model.ID, Tier: model.Tier, CostLabel: model.CostLabel}
	}
	return out
}

func teamExists(teams []TeamProfile) func(string) bool {
	return func(id string) bool {
		for _, team := range teams {
			if team.ID == id {
				return true
			}
		}
		return false
	}
}

func supportsAgent(agentIDs []string, agentID string) bool {
	for _, id := range agentIDs {
		if id == agentID {
			return true
		}
	}
	return false
}
