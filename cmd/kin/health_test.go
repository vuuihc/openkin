package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// A health check has to see the daemon, not the binary. `kin version` answers
// even when nothing is listening, which is exactly the state an installer must
// not mistake for ready.
func TestRunHealthChecksTheDaemonsAnswer(t *testing.T) {
	serving := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer serving.Close()
	if err := runHealth([]string{"--addr", serving.URL}); err != nil {
		t.Fatalf("serving daemon = %v, want healthy", err)
	}

	wedged := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer wedged.Close()
	if err := runHealth([]string{"--addr", wedged.URL}); err == nil {
		t.Fatal("a daemon answering 503 was reported healthy")
	}
}

func TestRunHealthChecksTheAddressItWasGiven(t *testing.T) {
	// The container runs the Hub on loopback, so a check that ignored --addr
	// would probe this test process instead of the server under test.
	serving := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			t.Errorf("probed %q, want /api/health", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer serving.Close()

	if err := runHealth([]string{"--addr", serving.URL + "/"}); err != nil {
		t.Fatalf("trailing slash = %v", err)
	}
}
