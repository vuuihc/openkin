package store

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestKinMessagesRoundTrip(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()

	task := Task{
		ID: "01KINMSG000000000000000001", Title: "t", Agent: "kin",
		Cwd: "/tmp", Prompt: "hi", Status: "queued", CreatedAt: NowMilli(),
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	tc, _ := json.Marshal([]map[string]any{
		{"id": "c1", "type": "function", "function": map[string]string{"name": "bash", "arguments": `{"command":"ls"}`}},
	})
	msgs := []KinMessage{
		{Role: "user", Content: "list files"},
		{Role: "assistant", Content: "", ToolCalls: tc},
		{Role: "tool", Name: "bash", ToolCallID: "c1", Content: "bash [ok] $ ls\nmain.go"},
		{Role: "assistant", Content: "done"},
	}
	if err := s.ReplaceKinMessages(ctx, task.ID, msgs); err != nil {
		t.Fatal(err)
	}
	got, err := s.LoadKinMessages(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 4 {
		t.Fatalf("len=%d", len(got))
	}
	if got[2].Name != "bash" || got[2].ToolCallID != "c1" {
		t.Fatalf("tool row %+v", got[2])
	}
	if len(got[1].ToolCalls) == 0 {
		t.Fatal("tool_calls not restored")
	}

	if err := s.ClearKinMessages(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	got, err = s.LoadKinMessages(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("cleared len=%d", len(got))
	}
}

func TestSearchEvents(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	id := "01SEARCH000000000000000001"
	if err := s.InsertTask(ctx, Task{
		ID: id, Title: "t", Agent: "kin", Cwd: "/tmp", Prompt: "p",
		Status: "queued", CreatedAt: NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendEvent(ctx, id, "message", []byte(`{"role":"user","text":"hello UNIQUE_TOKEN_XYZ"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendEvent(ctx, id, "tool_result", []byte(`{"output":"other stuff"}`)); err != nil {
		t.Fatal(err)
	}

	hits, err := s.SearchEvents(ctx, id, "UNIQUE_TOKEN_XYZ", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 {
		t.Fatalf("hits=%d", len(hits))
	}
	if hits[0].Type != "message" {
		t.Fatalf("type=%s", hits[0].Type)
	}
	if hits[0].Snippet == "" {
		t.Fatal("empty snippet")
	}
}
