package server

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestParseServeFlagsFunnelRequiresTailscale(t *testing.T) {
	_, err := ParseServeFlags([]string{"--funnel"})
	if err == nil || !strings.Contains(err.Error(), "--tailscale") {
		t.Fatalf("err = %v", err)
	}
}

func TestParseServeFlagsFunnelWithControlURL(t *testing.T) {
	_, err := ParseServeFlags([]string{
		"--tailscale", "--funnel", "--ts-control-url", "https://example.com",
	})
	if err == nil {
		t.Fatal("expected error")
	}
	msg := err.Error()
	if !strings.Contains(strings.ToLower(msg), "funnel") {
		t.Fatalf("error should mention funnel: %s", msg)
	}
}

func TestParseServeFlagsOK(t *testing.T) {
	f, err := ParseServeFlags([]string{"--lan", "--port", "8888"})
	if err != nil {
		t.Fatal(err)
	}
	if !f.LAN || f.Port != 8888 {
		t.Fatalf("%+v", f)
	}
	f, err = ParseServeFlags([]string{"--tailscale", "--ts-control-url", "https://hs.example"})
	if err != nil {
		t.Fatal(err)
	}
	if !f.Tailscale || f.TSControlURL != "https://hs.example" {
		t.Fatalf("%+v", f)
	}
}

func TestParseServeFlagsRelay(t *testing.T) {
	f, err := ParseServeFlags([]string{"--relay", "wss://kin-relay.example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if f.RelayURL != "wss://kin-relay.example.com" {
		t.Fatalf("RelayURL = %q, want %q", f.RelayURL, "wss://kin-relay.example.com")
	}
}

func TestParseServeFlagsRelayWithLAN(t *testing.T) {
	f, err := ParseServeFlags([]string{"--lan", "--relay", "wss://relay.example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if !f.LAN {
		t.Fatal("LAN should be true")
	}
	if f.RelayURL != "wss://relay.example.com" {
		t.Fatalf("RelayURL = %q", f.RelayURL)
	}
}

func TestNetworkModeRelay(t *testing.T) {
	f := ServeFlags{RelayURL: "wss://relay.example.com"}
	mode := networkMode(f)
	if !strings.Contains(mode, "relay") {
		t.Fatalf("networkMode = %q, want relay included", mode)
	}
	if !strings.Contains(mode, "loopback") {
		t.Fatalf("networkMode = %q, want loopback included", mode)
	}

	// Relay + LAN.
	f2 := ServeFlags{LAN: true, RelayURL: "wss://relay.example.com"}
	mode2 := networkMode(f2)
	if !strings.Contains(mode2, "relay") || !strings.Contains(mode2, "lan") {
		t.Fatalf("networkMode = %q, want lan+relay", mode2)
	}
}

func TestParseServeFlagsDefaultsToStandalone(t *testing.T) {
	f, err := ParseServeFlags(nil)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if f.Role != RoleStandalone {
		t.Fatalf("role = %q, want %q", f.Role, RoleStandalone)
	}
}

func TestParseServeFlagsHub(t *testing.T) {
	f, err := ParseServeFlags([]string{"--role", "hub", "--domain", "Kin.Example.com", "--acme-email", "me@example.com"})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if f.Role != RoleHub {
		t.Fatalf("role = %q", f.Role)
	}
	if f.Domain != "Kin.Example.com" {
		// Normalization happens in remote.NewHub, which is where the value is
		// actually consumed; the flag layer must not silently rewrite it.
		t.Fatalf("domain = %q", f.Domain)
	}
}

func TestParseServeFlagsHubRequiresDomain(t *testing.T) {
	if _, err := ParseServeFlags([]string{"--role", "hub"}); err == nil {
		t.Fatal("--role hub without --domain must be rejected")
	}
}

func TestParseServeFlagsDomainRequiresHubRole(t *testing.T) {
	if _, err := ParseServeFlags([]string{"--domain", "kin.example.com"}); err == nil {
		t.Fatal("--domain without --role hub must be rejected rather than ignored")
	}
}

func TestParseServeFlagsRejectsUnknownRole(t *testing.T) {
	// `node` is a real role in the multi-device design, but accepting the flag
	// before the role exists would let a deployment look configured while
	// behaving as a standalone daemon.
	_, err := ParseServeFlags([]string{"--role", "node"})
	if err == nil {
		t.Fatal("--role node must be rejected until it is implemented")
	}
	if !strings.Contains(err.Error(), "node") {
		t.Fatalf("error should name the rejected role: %v", err)
	}
}

// Where this machine keeps the repositories it fetches is a boundary, so the
// three ways of naming it are decided in one place rather than three.
func TestResolveCheckoutRoot(t *testing.T) {
	stateDir := filepath.Join(string(filepath.Separator), "state", "kin")
	for _, tc := range []struct {
		name     string
		declared string
		want     string
	}{
		{name: "unset is under the state directory", declared: "", want: filepath.Join(stateDir, "checkouts")},
		{name: "unset and padded is the same", declared: "  ", want: filepath.Join(stateDir, "checkouts")},
		{name: "off means it fetches nothing", declared: "off", want: ""},
		{name: "off in any case", declared: "OFF", want: ""},
		{name: "a path is taken as given", declared: stateDir + "/clones", want: stateDir + "/clones"},
		{name: "a relative path is made absolute", declared: "clones", want: "REPLACED"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolveCheckoutRoot(stateDir, tc.declared)
			if err != nil {
				t.Fatalf("resolveCheckoutRoot(%q): %v", tc.declared, err)
			}
			if tc.want == "REPLACED" {
				if !filepath.IsAbs(got) {
					t.Fatalf("resolveCheckoutRoot(%q) = %q, want an absolute path", tc.declared, got)
				}
				return
			}
			if got != tc.want {
				t.Fatalf("resolveCheckoutRoot(%q) = %q, want %q", tc.declared, got, tc.want)
			}
		})
	}
}
