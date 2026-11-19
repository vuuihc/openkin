package agent

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

// listProbeCount is the size of the registry the daemon assembles on this
// machine: internal/adapter/detect/skills_catalog.go lists 74 discovery specs,
// and every one of them can become a registration. Sizing the test to the real
// fan-out keeps it honest about the boot path it is protecting.
const listProbeCount = 74

// probeSleep is how long one fake probe blocks. It stands in for the real
// per-agent work — a PATH lookup for Status, a settings-file read for Models —
// without depending on what happens to be installed on the test machine.
const probeSleep = 3 * time.Millisecond

// sleepProbe blocks like a filesystem probe and honours cancellation the way
// the real Status/Models implementations are expected to.
func sleepProbe(ctx context.Context) {
	timer := time.NewTimer(probeSleep)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
	}
}

// TestListProbesRegistrationsConcurrently pins the fan-out. 74 registrations ×
// (3 ms Status + 3 ms Models) is ~444 ms sequentially, measured at 556 ms
// before the fan-out existed. A bounded concurrent run measures 40–65 ms on
// this machine, including runs under GOMAXPROCS=2; the 200 ms bound is 2.2×
// below the sequential floor and 3× above the concurrent range, so neither a
// loaded build machine nor the red side is ambiguous.
func TestListProbesRegistrationsConcurrently(t *testing.T) {
	entries := make([]Entry, 0, listProbeCount)
	for i := 0; i < listProbeCount; i++ {
		id := fmt.Sprintf("agent-%02d", i)
		entries = append(entries, Entry{
			ID:       id,
			Name:     id,
			Priority: i,
			Runner:   stubAdapter{},
			Status: func(ctx context.Context) Status {
				sleepProbe(ctx)
				return Status{Installed: true, Available: true}
			},
			Models: func(ctx context.Context) ModelList {
				sleepProbe(ctx)
				return ModelList{Source: "test", Status: "available"}
			},
		})
	}
	r := MustRegistry(entries...)

	start := time.Now()
	list := r.List(context.Background(), "")
	elapsed := time.Since(start)

	if len(list) != listProbeCount {
		t.Fatalf("List returned %d registrations, want %d", len(list), listProbeCount)
	}
	if elapsed >= 200*time.Millisecond {
		t.Fatalf("List probed %d registrations serially: %v (want < 200ms; "+
			"%d × %v for Status + Models is ~%v sequential)",
			listProbeCount, elapsed, listProbeCount, probeSleep, listProbeCount*2*probeSleep)
	}
}

// TestListMatchesSequentialOrder is the behaviour pin for the concurrent
// implementation: same rows in the same order, with the same default flag and
// the same every other field, as the sequential reference below. It passes on
// either side of the change; the concurrency test above is what fails before
// the fan-out exists.
func TestListMatchesSequentialOrder(t *testing.T) {
	entries := make([]Entry, 0, 24)
	for i := 0; i < 24; i++ {
		i := i
		id := fmt.Sprintf("agent-%02d", i)
		// Priorities collide on purpose so the (priority, id) tie-break is
		// exercised rather than accidentally satisfied by insertion order.
		priority := (i * 7) % 5
		available := i%4 != 0
		var models func(context.Context) ModelList
		if i%3 != 0 {
			// The plugin owns this one slice and hands it out on every call, the
			// way a registration that reads its settings once would. List must
			// copy it out; a fresh slice per call would hide a missing copy.
			opts := []ModelOption{
				{ID: fmt.Sprintf("model-%02d-a", i), Label: "A", Tier: "fast"},
				{ID: fmt.Sprintf("model-%02d-b", i), Label: "B", Tier: "deep"},
			}
			models = func(context.Context) ModelList {
				return ModelList{
					Models: opts,
					Source: fmt.Sprintf("source-%02d", i),
					Status: "available",
				}
			}
		}
		entries = append(entries, Entry{
			ID:       id,
			Name:     fmt.Sprintf("Agent %02d", i),
			Kind:     KindCLI,
			Priority: priority,
			Caps:     []Capability{CapabilityRun, CapabilityResume},
			Runner:   stubAdapter{},
			Status: func(context.Context) Status {
				return Status{
					Installed: i%4 != 3,
					Available: available,
					Reason:    fmt.Sprintf("reason-%02d", i),
					Binary:    fmt.Sprintf("/bin/%02d", i),
				}
			},
			Models: models,
		})
	}
	r := MustRegistry(entries...)

	want := sequentialList(r, "")
	got := r.List(context.Background(), "")

	if !reflect.DeepEqual(got, want) {
		for i := range want {
			if i >= len(got) || !reflect.DeepEqual(got[i], want[i]) {
				t.Fatalf("List row %d = %+v, want %+v\nfull got:  %+v\nfull want: %+v",
					i, got[i], want[i], got, want)
			}
		}
		t.Fatalf("List returned %d rows, want %d", len(got), len(want))
	}

	// The models slice is copied out of the registration. A caller editing the
	// returned Info must not reach back into the plugin's own slice.
	withModels := -1
	for i := range got {
		if len(got[i].Models) > 0 {
			withModels = i
			break
		}
	}
	if withModels < 0 {
		t.Fatal("test registry produced no row with models; the copy check cannot run")
	}
	got[withModels].Models[0].ID = "mutated"
	if fresh := r.List(context.Background(), ""); fresh[withModels].Models[0].ID == "mutated" {
		t.Fatal("List returned the plugin's own Models slice instead of a copy")
	}
}

// TestListSurvivesAProbePanic covers the failure mode the fan-out introduced:
// probes are adapter code running in goroutines List owns, where an
// unrecovered panic ends the process. One buggy probe must cost one row, not
// the daemon.
func TestListSurvivesAProbePanic(t *testing.T) {
	r := MustRegistry(
		Entry{
			ID: "status-boom", Name: "Status Boom", Priority: 1, Runner: stubAdapter{},
			Status: func(context.Context) Status { panic("status exploded") },
		},
		Entry{
			ID: "models-boom", Name: "Models Boom", Priority: 2, Runner: stubAdapter{},
			Status: func(context.Context) Status { return Status{Installed: true, Available: true} },
			Models: func(context.Context) ModelList { panic("models exploded") },
		},
		Entry{ID: "fine", Name: "Fine", Priority: 3, Runner: stubAdapter{}},
	)

	list := r.List(context.Background(), "")
	if len(list) != 3 {
		t.Fatalf("List returned %d rows, want 3: a panic must not drop a registration", len(list))
	}
	if list[0].ID != "status-boom" || list[2].ID != "fine" {
		t.Fatalf("order changed around a panic: %s, %s, %s", list[0].ID, list[1].ID, list[2].ID)
	}
	byID := make(map[string]Info, len(list))
	for _, info := range list {
		byID[info.ID] = info
	}
	for id, panicText := range map[string]string{
		"status-boom": "status exploded",
		"models-boom": "models exploded",
	} {
		info := byID[id]
		if info.Available {
			t.Errorf("%s stayed available after its probe panicked", id)
		}
		if !strings.Contains(info.Reason, "probe panicked") || !strings.Contains(info.Reason, panicText) {
			t.Errorf("%s Reason = %q, want the panic named", id, info.Reason)
		}
	}
	if !byID["fine"].Available {
		t.Error("a healthy registration was collateral damage")
	}
	for _, info := range list {
		if info.Default {
			t.Errorf("%s became default although the default scan panicked", info.ID)
		}
	}
}

// sequentialList is the pre-concurrency implementation, kept here as the
// reference the concurrent one is compared against.
func sequentialList(r *Registry, configuredDefault string) []Info {
	def := r.Default(context.Background(), configuredDefault)
	out := make([]Info, 0, len(r.order))
	for _, id := range r.order {
		reg := r.byID[id]
		st := reg.Status(context.Background())
		models := ModelList{Source: "none", Status: "unavailable"}
		if reg.Models != nil {
			models = reg.Models(context.Background())
			models.Models = append([]ModelOption(nil), models.Models...)
		}
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
			Models:       models.Models,
			ModelSource:  models.Source,
			ModelStatus:  models.Status,
		})
	}
	return out
}
