package store

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func seedTranscriptTask(t *testing.T, s *Store, id, title, owner string) {
	t.Helper()
	if err := s.InsertTask(context.Background(), Task{
		ID: id, Title: title, Agent: "claude-code", Cwd: "/tmp", Prompt: "p",
		Status: "finished", CreatedAt: NowMilli(), OwnerUserID: owner,
	}); err != nil {
		t.Fatal(err)
	}
}

func appendMessage(t *testing.T, s *Store, taskID string, payload string) {
	t.Helper()
	if _, err := s.AppendEvent(context.Background(), taskID, "message", []byte(payload)); err != nil {
		t.Fatal(err)
	}
}

// message builds the payload the console's transcript renders.
func message(role string, blocks ...map[string]any) string {
	raw, err := json.Marshal(map[string]any{"role": role, "content": blocks})
	if err != nil {
		panic(err)
	}
	return string(raw)
}

func textBlock(text string) map[string]any {
	return map[string]any{"type": "text", "text": text}
}

func TestSearchTranscriptFindsProseInBothRoles(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	seedTranscriptTask(t, s, "01TRANS0000000000000000001", "Deploy notes", "")
	appendMessage(t, s, "01TRANS0000000000000000001",
		message("user", textBlock("how do we roll back the UNIQUE_TOKEN service?")))
	appendMessage(t, s, "01TRANS0000000000000000001",
		message("assistant", textBlock("Run the UNIQUE_TOKEN rollback script.")))

	hits, truncated, err := s.SearchTranscript(context.Background(), TranscriptSearchOpts{Scope: TaskScope{All: true}, Query: "unique_token"})
	if err != nil {
		t.Fatal(err)
	}
	if truncated {
		t.Fatal("two hits are not truncated")
	}
	if len(hits) != 2 {
		t.Fatalf("hits=%d %+v", len(hits), hits)
	}
	// Newest first: the answer is seq 2, so it leads.
	if hits[0].Role != "assistant" || hits[1].Role != "user" {
		t.Fatalf("order/roles: %+v", hits)
	}
	if hits[0].TaskTitle != "Deploy notes" {
		t.Fatalf("title=%q", hits[0].TaskTitle)
	}
	if !strings.Contains(hits[0].Snippet, "UNIQUE_TOKEN rollback") {
		t.Fatalf("snippet=%q", hits[0].Snippet)
	}
	// Prose, not JSON: the payload's scaffolding must not leak into the line.
	if strings.Contains(hits[0].Snippet, `\"`) || strings.Contains(hits[0].Snippet, `"text"`) {
		t.Fatalf("snippet is raw payload: %q", hits[0].Snippet)
	}
}

func TestSearchTranscriptSkipsWhatIsNotProse(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	id := "01TRANS0000000000000000002"
	seedTranscriptTask(t, s, id, "t", "")
	// A tool block and a thought block, in the shape the adapters actually
	// write: the words live in `input` / `thinking`, never in a `text` field, so
	// neither is prose a reader can find on screen.
	appendMessage(t, s, id, message("assistant",
		map[string]any{"type": "tool_use", "name": "grep", "input": map[string]string{"pattern": "UNIQUE_TOKEN in a tool call"}},
		map[string]any{"type": "thinking", "thinking": "UNIQUE_TOKEN in a thought"},
	))
	if _, err := s.AppendEvent(context.Background(), id, "tool_result",
		[]byte(`{"output":"UNIQUE_TOKEN from a tool"}`)); err != nil {
		t.Fatal(err)
	}
	// The word itself lives in the schema keys of every message; a search for
	// it must not return the whole library.
	appendMessage(t, s, id, message("assistant", textBlock("no match here")))

	hits, _, err := s.SearchTranscript(context.Background(), TranscriptSearchOpts{Scope: TaskScope{All: true}, Query: "UNIQUE_TOKEN"})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 0 {
		t.Fatalf("hits=%+v", hits)
	}

	hits, _, err = s.SearchTranscript(context.Background(), TranscriptSearchOpts{Scope: TaskScope{All: true}, Query: "text"})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 0 {
		t.Fatalf("a JSON key matched prose: %+v", hits)
	}
}

func TestSearchTranscriptIsCaseFoldedAndUTF8Safe(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	id := "01TRANS0000000000000000003"
	seedTranscriptTask(t, s, id, "t", "")
	appendMessage(t, s, id, message("assistant", textBlock("Deploy 上线 完成，记得检查 50% 的流量")))

	for _, q := range []string{"deploy", "DEPLOY", "上线", "50%"} {
		hits, _, err := s.SearchTranscript(context.Background(), TranscriptSearchOpts{Scope: TaskScope{All: true}, Query: q})
		if err != nil {
			t.Fatalf("%q: %v", q, err)
		}
		if len(hits) != 1 {
			t.Fatalf("%q: hits=%+v", q, hits)
		}
	}
	// `%` is a character, not a wildcard.
	hits, _, err := s.SearchTranscript(context.Background(), TranscriptSearchOpts{Scope: TaskScope{All: true}, Query: "5%0"})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 0 {
		t.Fatalf("wildcard semantics: %+v", hits)
	}
}

func TestSearchTranscriptMatchesJSONEscapedText(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	id := "01TRANS0000000000000000004"
	seedTranscriptTask(t, s, id, "t", "")
	// The stored payload holds `\"quoted\"` and `<tag>`, not the
	// characters the person typed into the search box.
	appendMessage(t, s, id, message("user", textBlock(`use "quoted" and <tag> here`)))

	for _, q := range []string{`"quoted"`, "<tag>"} {
		hits, _, err := s.SearchTranscript(context.Background(), TranscriptSearchOpts{Scope: TaskScope{All: true}, Query: q})
		if err != nil {
			t.Fatalf("%q: %v", q, err)
		}
		if len(hits) != 1 {
			t.Fatalf("%q: hits=%+v", q, hits)
		}
	}
}

func TestSearchTranscriptRespectsScopeAndTask(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	seedTranscriptTask(t, s, "01TRANS0000000000000000005", "mine", "user-a")
	seedTranscriptTask(t, s, "01TRANS0000000000000000006", "theirs", "user-b")
	appendMessage(t, s, "01TRANS0000000000000000005", message("user", textBlock("SCOPE_TOKEN mine")))
	appendMessage(t, s, "01TRANS0000000000000000006", message("user", textBlock("SCOPE_TOKEN theirs")))

	all, _, err := s.SearchTranscript(context.Background(), TranscriptSearchOpts{Scope: TaskScope{All: true}, Query: "SCOPE_TOKEN"})
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("unscoped hits=%d", len(all))
	}

	mine, _, err := s.SearchTranscript(context.Background(), TranscriptSearchOpts{
		Query: "SCOPE_TOKEN",
		Scope: TaskScope{OwnerUserID: "user-a"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(mine) != 1 || mine[0].TaskID != "01TRANS0000000000000000005" {
		t.Fatalf("scoped hits=%+v", mine)
	}

	none, _, err := s.SearchTranscript(context.Background(), TranscriptSearchOpts{
		Query: "SCOPE_TOKEN",
		Scope: TaskScope{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(none) != 0 {
		t.Fatalf("empty scope sees everything: %+v", none)
	}

	one, _, err := s.SearchTranscript(context.Background(), TranscriptSearchOpts{
		Scope:  TaskScope{All: true},
		Query:  "SCOPE_TOKEN",
		TaskID: "01TRANS0000000000000000006",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(one) != 1 || one[0].TaskID != "01TRANS0000000000000000006" {
		t.Fatalf("task-scoped hits=%+v", one)
	}
}

func TestSearchTranscriptSaysWhenItStopped(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	id := "01TRANS0000000000000000007"
	seedTranscriptTask(t, s, id, "t", "")
	for i := 0; i < 4; i++ {
		appendMessage(t, s, id, message("user", textBlock("MANY_TOKEN")))
	}

	hits, truncated, err := s.SearchTranscript(context.Background(), TranscriptSearchOpts{
		Scope: TaskScope{All: true}, Query: "MANY_TOKEN", Limit: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 3 {
		t.Fatalf("hits=%d", len(hits))
	}
	if !truncated {
		t.Fatal("a fourth match must be reported as truncated")
	}
}

func TestSearchTranscriptRefusesWhatItCannotAnswer(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	if _, _, err := s.SearchTranscript(context.Background(), TranscriptSearchOpts{Scope: TaskScope{All: true}, Query: "   "}); err == nil {
		t.Fatal("an empty query is not a search")
	}
}

func TestSearchTranscriptSurvivesABadPayload(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	id := "01TRANS0000000000000000008"
	seedTranscriptTask(t, s, id, "t", "")
	if _, err := s.AppendEvent(context.Background(), id, "message",
		[]byte(`{"role":"assistant","content":[{"type":"text","text":"BROKEN_TOKEN"),`)); err != nil {
		t.Fatal(err)
	}
	appendMessage(t, s, id, message("assistant", textBlock("BROKEN_TOKEN is fine here")))

	hits, _, err := s.SearchTranscript(context.Background(), TranscriptSearchOpts{Scope: TaskScope{All: true}, Query: "BROKEN_TOKEN"})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 {
		t.Fatalf("hits=%+v", hits)
	}
}

// The row is matched against raw text but its snippet is cut from collapsed
// text: a query that spans a run of spaces must still produce a snippet around
// the match instead of the head of the message.
func TestSearchTranscriptSnippetsAroundAWhitespaceMatch(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000025"
	seedTranscriptTask(t, s, taskID, "Spacing", "")
	appendMessage(t, s, taskID, `{"role":"assistant","content":[{"type":"text","text":"`+
		strings.Repeat("x", 200)+`    needle"}]}`)

	hits := searchAll(t, s, "    needle")
	if len(hits) != 1 {
		t.Fatalf("hits=%d want 1: %+v", len(hits), hits)
	}
	if !strings.Contains(hits[0].Snippet, "needle") {
		t.Fatalf("snippet=%q does not show the match", hits[0].Snippet)
	}
}
