package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestListModels(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("path %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer sk-test" {
			t.Fatalf("auth %q", r.Header.Get("Authorization"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]string{
				{"id": "gpt-5.1"},
				{"id": "gpt-4.1-mini"},
			},
		})
	}))
	defer srv.Close()

	ids, err := ListModels(context.Background(), Config{
		Kind:    "openai-compatible",
		BaseURL: srv.URL + "/v1",
		APIKey:  "sk-test",
	})
	if err != nil {
		t.Fatalf("ListModels: %v", err)
	}
	want := []string{"gpt-4.1-mini", "gpt-5.1"}
	if len(ids) != len(want) || ids[0] != want[0] || ids[1] != want[1] {
		t.Fatalf("ids = %v, want %v", ids, want)
	}
}

func TestListModelsHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]string{"message": "invalid api key"},
		})
	}))
	defer srv.Close()

	_, err := ListModels(context.Background(), Config{
		BaseURL: srv.URL + "/v1",
	})
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestListModelsUnsupportedKind(t *testing.T) {
	_, err := ListModels(context.Background(), Config{
		Kind:    "anthropic",
		BaseURL: "https://example.com/v1",
	})
	if err == nil {
		t.Fatal("expected error for unsupported kind")
	}
}
