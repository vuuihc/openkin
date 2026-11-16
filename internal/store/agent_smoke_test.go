package store

import (
	"context"
	"path/filepath"
	"testing"
)

func TestAgentSmokeRoundTrip(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()

	if _, ok, err := st.GetAgentSmoke(ctx, "pi"); err != nil || ok {
		t.Fatalf("empty: ok=%v err=%v", ok, err)
	}

	err = st.SetAgentSmoke(ctx, "pi", AgentSmokeResult{
		OK:     true,
		Binary: "/usr/bin/pi",
		Detail: "",
	})
	if err != nil {
		t.Fatal(err)
	}
	got, ok, err := st.GetAgentSmoke(ctx, "pi")
	if err != nil || !ok || !got.OK || got.Binary != "/usr/bin/pi" {
		t.Fatalf("got=%+v ok=%v err=%v", got, ok, err)
	}

	err = st.SetAgentSmoke(ctx, "pi", AgentSmokeResult{
		OK:     false,
		Binary: "/usr/bin/pi",
		Detail: "timeout",
	})
	if err != nil {
		t.Fatal(err)
	}
	got, ok, err = st.GetAgentSmoke(ctx, "pi")
	if err != nil || !ok || got.OK || got.Detail != "timeout" {
		t.Fatalf("updated=%+v ok=%v err=%v", got, ok, err)
	}
}
