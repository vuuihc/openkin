package agent

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/vuuihc/kin/internal/adapter"
)

var idPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// Sentinel errors for GetRunnable.
var (
	ErrUnknownAgent     = errors.New("unknown agent")
	ErrAgentUnavailable = errors.New("agent unavailable")
	ErrAgentNotRunnable = errors.New("agent not runnable")
)

// Registry is an immutable set of opened agent plugins.
type Registry struct {
	byID  map[string]Registration
	order []string // sorted by (priority, id) for stable iteration
}

// Build opens factories and validates registrations.
func Build(ctx context.Context, factories ...Factory) (*Registry, error) {
	byID := make(map[string]Registration, len(factories))
	for _, f := range factories {
		if f == nil {
			return nil, fmt.Errorf("agent: nil factory")
		}
		desc := f.Descriptor()
		if err := validateDescriptor(desc); err != nil {
			return nil, err
		}
		if _, dup := byID[desc.ID]; dup {
			return nil, fmt.Errorf("agent: duplicate id %q", desc.ID)
		}
		reg, err := f.Open(ctx)
		if err != nil {
			return nil, fmt.Errorf("agent %q: open: %w", desc.ID, err)
		}
		if err := validateRegistration(desc, reg); err != nil {
			return nil, err
		}
		// Prefer descriptor from factory as source of truth for static fields.
		reg.Descriptor = normalizeDescriptor(desc)
		// Prefer Runner/Controller/Sessions/Status from Open; fill ID if empty.
		if reg.Descriptor.ID == "" {
			reg.Descriptor.ID = desc.ID
		}
		byID[desc.ID] = reg
	}
	order := make([]string, 0, len(byID))
	for id := range byID {
		order = append(order, id)
	}
	sort.Slice(order, func(i, j int) bool {
		a, b := byID[order[i]], byID[order[j]]
		if a.Descriptor.Priority != b.Descriptor.Priority {
			return a.Descriptor.Priority < b.Descriptor.Priority
		}
		return order[i] < order[j]
	})
	return &Registry{byID: byID, order: order}, nil
}

// Entry is a direct registration used by tests and migration helpers.
type Entry struct {
	ID         string
	Name       string
	Kind       Kind
	Priority   int
	Caps       []Capability
	Runner     adapter.Adapter
	Controller Controller
	Sessions   SessionHooks
	Status     func(context.Context) Status
}

// NewRegistry builds a registry from explicit entries (tests / migration).
// Entries skip Factory.Open but still validate IDs and capability contracts.
func NewRegistry(entries ...Entry) (*Registry, error) {
	byID := make(map[string]Registration, len(entries))
	for _, e := range entries {
		name := e.Name
		if name == "" {
			name = e.ID
		}
		kind := e.Kind
		if kind == "" {
			kind = KindCLI
		}
		caps := e.Caps
		if caps == nil {
			caps = []Capability{CapabilityRun, CapabilityResume}
		}
		desc := Descriptor{
			ID:           e.ID,
			Name:         name,
			Kind:         kind,
			Priority:     e.Priority,
			Capabilities: caps,
		}
		if err := validateDescriptor(desc); err != nil {
			return nil, err
		}
		if _, dup := byID[desc.ID]; dup {
			return nil, fmt.Errorf("agent: duplicate id %q", desc.ID)
		}
		status := e.Status
		if status == nil {
			runner := e.Runner
			status = func(context.Context) Status {
				return Status{Installed: runner != nil, Available: runner != nil}
			}
		}
		reg := Registration{
			Descriptor: normalizeDescriptor(desc),
			Runner:     e.Runner,
			Controller: e.Controller,
			Sessions:   e.Sessions,
			Status:     status,
		}
		if err := validateRegistration(desc, reg); err != nil {
			return nil, err
		}
		byID[desc.ID] = reg
	}
	order := make([]string, 0, len(byID))
	for id := range byID {
		order = append(order, id)
	}
	sort.Slice(order, func(i, j int) bool {
		a, b := byID[order[i]], byID[order[j]]
		if a.Descriptor.Priority != b.Descriptor.Priority {
			return a.Descriptor.Priority < b.Descriptor.Priority
		}
		return order[i] < order[j]
	})
	return &Registry{byID: byID, order: order}, nil
}

// MustRegistry is NewRegistry that panics on error (tests).
func MustRegistry(entries ...Entry) *Registry {
	r, err := NewRegistry(entries...)
	if err != nil {
		panic(err)
	}
	return r
}

func validateDescriptor(d Descriptor) error {
	if !idPattern.MatchString(d.ID) {
		return fmt.Errorf("agent: invalid id %q", d.ID)
	}
	if strings.TrimSpace(d.Name) == "" {
		return fmt.Errorf("agent %q: empty name", d.ID)
	}
	if d.Priority < 0 {
		return fmt.Errorf("agent %q: negative priority", d.ID)
	}
	return nil
}

func validateRegistration(desc Descriptor, reg Registration) error {
	if reg.Status == nil {
		return fmt.Errorf("agent %q: nil Status", desc.ID)
	}
	caps := dedupeCaps(desc.Capabilities)
	hasOrch := false
	for _, c := range caps {
		if c == CapabilityOrchestrate {
			hasOrch = true
			break
		}
	}
	if hasOrch && reg.Controller == nil {
		return fmt.Errorf("agent %q: orchestrate requires Controller", desc.ID)
	}
	return nil
}

func normalizeDescriptor(d Descriptor) Descriptor {
	d.Capabilities = dedupeCaps(d.Capabilities)
	return d
}

func dedupeCaps(caps []Capability) []Capability {
	if len(caps) == 0 {
		return nil
	}
	seen := make(map[Capability]bool, len(caps))
	var out []Capability
	// Stable preferred order.
	pref := []Capability{
		CapabilityRun, CapabilityResume, CapabilityTools,
		CapabilityApprovals, CapabilityOrchestrate,
	}
	for _, p := range pref {
		for _, c := range caps {
			if c == p && !seen[c] {
				seen[c] = true
				out = append(out, c)
			}
		}
	}
	for _, c := range caps {
		if !seen[c] {
			seen[c] = true
			out = append(out, c)
		}
	}
	return out
}

// Get returns a registration by id.
func (r *Registry) Get(id string) (Registration, bool) {
	if r == nil {
		return Registration{}, false
	}
	reg, ok := r.byID[id]
	return reg, ok
}

// IDs returns registered agent ids in stable priority order.
func (r *Registry) IDs() []string {
	if r == nil {
		return nil
	}
	out := make([]string, len(r.order))
	copy(out, r.order)
	return out
}

// Default selects the configured ready agent first, else lowest (priority, id).
func (r *Registry) Default(ctx context.Context, configuredID string) string {
	if r == nil {
		return ""
	}
	configuredID = strings.TrimSpace(configuredID)
	if configuredID != "" {
		if reg, ok := r.byID[configuredID]; ok {
			st := reg.Status(ctx)
			if st.Available && reg.Runner != nil {
				return configuredID
			}
		}
	}
	for _, id := range r.order {
		reg := r.byID[id]
		st := reg.Status(ctx)
		if st.Available && reg.Runner != nil {
			return id
		}
	}
	return ""
}

// GetRunnable returns a registration that can execute a run.
func (r *Registry) GetRunnable(ctx context.Context, id string) (Registration, error) {
	if r == nil {
		return Registration{}, ErrUnknownAgent
	}
	reg, ok := r.byID[id]
	if !ok {
		return Registration{}, fmt.Errorf("%w: %s", ErrUnknownAgent, id)
	}
	st := reg.Status(ctx)
	if !st.Available {
		reason := st.Reason
		if reason == "" {
			reason = "not available"
		}
		return Registration{}, fmt.Errorf("%w: %s (%s)", ErrAgentUnavailable, id, reason)
	}
	if reg.Runner == nil || !reg.Descriptor.Has(CapabilityRun) {
		return Registration{}, fmt.Errorf("%w: %s", ErrAgentNotRunnable, id)
	}
	return reg, nil
}

// List returns API-safe info for all plugins.
func (r *Registry) List(ctx context.Context, configuredDefault string) []Info {
	if r == nil {
		return nil
	}
	def := r.Default(ctx, configuredDefault)
	out := make([]Info, 0, len(r.order))
	for _, id := range r.order {
		reg := r.byID[id]
		st := reg.Status(ctx)
		out = append(out, Info{
			ID:           reg.Descriptor.ID,
			Name:         reg.Descriptor.Name,
			Kind:         reg.Descriptor.Kind,
			Capabilities: append([]Capability(nil), reg.Descriptor.Capabilities...),
			Installed:    st.Installed,
			Available:    st.Available,
			Reason:       st.Reason,
			Binary:       st.Binary,
			Default:      id == def && def != "",
		})
	}
	return out
}

// ResetSession invokes session hooks for a plugin if present.
func (r *Registry) ResetSession(ctx context.Context, id, taskID string) error {
	if r == nil {
		return nil
	}
	reg, ok := r.byID[id]
	if !ok || reg.Sessions == nil {
		return nil
	}
	return reg.Sessions.Reset(ctx, taskID)
}

// Has reports whether an agent id is registered (regardless of readiness).
func (r *Registry) Has(id string) bool {
	if r == nil {
		return false
	}
	_, ok := r.byID[id]
	return ok
}
