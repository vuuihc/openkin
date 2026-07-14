package remote

import (
	"strings"
	"testing"
)

func TestLANURL(t *testing.T) {
	url := LANURL(7777, "abc123token")
	if !strings.HasPrefix(url, "http://") {
		t.Fatalf("url = %q, want http prefix", url)
	}
	if !strings.Contains(url, ":7777/?token=abc123token") {
		t.Fatalf("url = %q, want port and token", url)
	}
	// Primary IP should not be empty.
	ip := PrimaryLANIP()
	if ip == "" {
		t.Fatal("PrimaryLANIP empty")
	}
	if !strings.Contains(url, ip) {
		t.Fatalf("url %q should contain primary IP %q", url, ip)
	}
}

func TestLANURLDefaultPort(t *testing.T) {
	url := LANURL(0, "tok")
	if !strings.Contains(url, ":7777/") {
		t.Fatalf("default port missing: %s", url)
	}
}
