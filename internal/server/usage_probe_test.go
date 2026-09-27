package server

import "testing"

func TestUsageWindowProbers(t *testing.T) {
	tests := []struct {
		name string
		env  string
		want []string
	}{
		{name: "default probes both CLIs", env: "", want: []string{"claude", "codex"}},
		{name: "disabled", env: "1", want: nil},
		{name: "disabled spelled true", env: "TRUE", want: nil},
		{name: "explicitly enabled", env: "0", want: []string{"claude", "codex"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("KIN_DISABLE_USAGE_WINDOWS", tt.env)
			probers := usageWindowProbers()
			if len(probers) != len(tt.want) {
				t.Fatalf("got %d probers, want %d", len(probers), len(tt.want))
			}
			for i, p := range probers {
				if p.ID() != tt.want[i] {
					t.Errorf("prober %d ID = %q, want %q", i, p.ID(), tt.want[i])
				}
			}
		})
	}
}
