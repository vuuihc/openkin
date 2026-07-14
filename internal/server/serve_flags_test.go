package server

import (
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
