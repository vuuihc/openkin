package agent

import "testing"

func TestFamilyCollapsesTransportVariants(t *testing.T) {
	cases := []struct {
		id   string
		want string
	}{
		{"claude-code", "claude"},
		{"claude-acp", "claude"},
		{"codex", "codex"},
		{"codex-acp", "codex"},
		{"droid-acp", "droid"},
		{"pi-acp", "pi"},
		{"kin", "kin"},
		{"gemini", "gemini"},
	}
	for _, tc := range cases {
		if got := Family(tc.id); got != tc.want {
			t.Errorf("Family(%q) = %q, want %q", tc.id, got, tc.want)
		}
	}
}

func TestTransportSeparatesTheThreeWaysToRunAnAgent(t *testing.T) {
	cases := []struct {
		id   string
		kind Kind
		want string
	}{
		{"claude-code", KindCLI, TransportNative},
		{"claude-acp", KindCLI, TransportACP},
		{"kin", KindBuiltin, TransportNative},
		{"gemini", KindCLI, TransportCLI},
	}
	for _, tc := range cases {
		if got := Transport(tc.id, tc.kind); got != tc.want {
			t.Errorf("Transport(%q, %q) = %q, want %q", tc.id, tc.kind, got, tc.want)
		}
	}
}
