package sessioncatalog

import "testing"

// The classifier is the one place that knows Claude Code's internal record
// flags: the live adapter and the file catalog both read this table through
// ClaudeRecordField. This test is the contract for every flag in it — adding a
// flag without classifying it here fails, and a flag that stops classifying a
// record as internal fails too.
func TestInternalClaudeRecordClassifierMatchesCatalog(t *testing.T) {
	if len(claudeRecordFlags) == 0 {
		t.Fatal("claudeRecordFlags is empty: the classifier has no known flags")
	}
	for _, flag := range claudeRecordFlags {
		t.Run(flag.name, func(t *testing.T) {
			record := map[string]any{
				"type":    "user",
				"uuid":    "uuid-" + flag.name,
				flag.name: true,
				"message": map[string]any{
					"role":    "user",
					"content": "provider-injected record",
				},
			}
			if got := ClassifyClaudeRecord(mapClaudeRecordField(record)); got != flag.class {
				t.Fatalf("%s classified %v, want %v", flag.name, got, flag.class)
			}
			if !isInternalClaudeRecord(record) {
				t.Fatalf("%s: file catalog would import it into history", flag.name)
			}

			// A known flag present but false changes nothing: default visible.
			record[flag.name] = false
			if got := ClassifyClaudeRecord(mapClaudeRecordField(record)); got != ClaudeRecordVisible {
				t.Fatalf("%s=false classified %v, want visible", flag.name, got)
			}
			if isInternalClaudeRecord(record) {
				t.Fatalf("%s=false: file catalog would drop it", flag.name)
			}
		})
	}
}

func TestClassifyClaudeRecordUserType(t *testing.T) {
	cases := []struct {
		name     string
		userType any
		want     ClaudeRecordClass
	}{
		{"internal", "internal", ClaudeRecordInternal},
		{"internal with spaces and case", " Internal ", ClaudeRecordInternal},
		{"external", "external", ClaudeRecordVisible},
		{"absent", nil, ClaudeRecordVisible},
		{"wrong shape", true, ClaudeRecordVisible},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			record := map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "hi"}}
			if tc.userType != nil {
				record["userType"] = tc.userType
			}
			if got := ClassifyClaudeRecord(mapClaudeRecordField(record)); got != tc.want {
				t.Fatalf("classified %v, want %v", got, tc.want)
			}
		})
	}
}

// A compaction summary is internal scaffolding, but it has a timeline home:
// the console's folded compaction row. When both it and a metadata flag are
// set, the summary wins so the reader keeps the disclosure.
func TestClassifyClaudeRecordSummaryBeatsInternalFlags(t *testing.T) {
	record := map[string]any{
		"type": "user", "isCompactSummary": true, "isMeta": true,
		"message": map[string]any{"role": "user", "content": "summary"},
	}
	if got := ClassifyClaudeRecord(mapClaudeRecordField(record)); got != ClaudeRecordCompactSummary {
		t.Fatalf("classified %v, want compact summary", got)
	}
}

// Default visible when no known flag is set: an ordinary message must never be
// hidden on a guess.
func TestClassifyClaudeRecordOrdinaryIsVisible(t *testing.T) {
	record := map[string]any{
		"type": "assistant", "isSidechain": false, "userType": "external",
		"message": map[string]any{"role": "assistant", "content": "answer"},
	}
	if got := ClassifyClaudeRecord(mapClaudeRecordField(record)); got != ClaudeRecordVisible {
		t.Fatalf("classified %v, want visible", got)
	}
}
