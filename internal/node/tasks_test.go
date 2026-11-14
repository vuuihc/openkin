package node

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The machine's loopback read must keep the page limit the Hub asked for. The
// console default can be larger, and reading it would make one relayed page
// exceed the frame the Hub intended to keep bounded.
func TestLocalTaskReaderCarriesTranscriptPaging(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.RequestURI()
		if r.Header.Get("Authorization") != "Bearer master-token" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	reader := LocalTaskReader(srv.URL+"/", func() string { return "master-token" })
	if _, err := reader.TaskEvents(context.Background(), "t-1", 50, 25); err != nil {
		t.Fatalf("the machine's transcript wasn't read: %v", err)
	}
	if want := "/api/tasks/t-1/events?limit=25&since_seq=50"; got != want {
		t.Fatalf("console path = %q, want %q", got, want)
	}
}
