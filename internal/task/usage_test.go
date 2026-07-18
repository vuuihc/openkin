package task

import (
	"encoding/json"
	"testing"

	"github.com/vuuihc/kin/internal/store"
)

func TestNormalizeUsage(t *testing.T) {
	zero := 0
	tests := []struct {
		name          string
		agent         string
		model         string
		payload       string
		wantInput     *int
		wantOutput    *int
		wantReasoning *int
		wantRead      *int
		wantWrite     *int
		wantStatus    string
		wantSemantics string
		wantLogical   int64
		wantEligible  bool
	}{
		{
			name:  "codex inclusive input",
			agent: "codex", model: "gpt-5.6",
			payload:   `{"source":"codex","input_tokens":24763,"output_tokens":122,"reasoning_output_tokens":17,"cache_read_tokens":24448,"cache_read_reported":true,"input_semantics":"total_includes_cache"}`,
			wantInput: intPtr(24763), wantOutput: intPtr(122), wantReasoning: intPtr(17), wantRead: intPtr(24448),
			wantStatus: store.CacheStatusReported, wantSemantics: store.InputSemanticsTotalIncludesCache,
			wantLogical: 24763, wantEligible: true,
		},
		{
			name:  "claude uncached input with cache write",
			agent: "claude-code", model: "claude-sonnet",
			payload:   `{"source":"claude-code","input_tokens":100,"output_tokens":25,"cache_read_tokens":800,"cache_write_tokens":100,"cache_read_reported":true,"input_semantics":"uncached_only"}`,
			wantInput: intPtr(100), wantOutput: intPtr(25), wantRead: intPtr(800), wantWrite: intPtr(100),
			wantStatus: store.CacheStatusReported, wantSemantics: store.InputSemanticsUncachedOnly,
			wantLogical: 1000, wantEligible: true,
		},
		{
			name:  "kin provider reports zero",
			agent: "kin", model: "gpt-test",
			payload:   `{"source":"kin","prompt_tokens":50,"completion_tokens":5,"cached_tokens":0,"cache_read_reported":true}`,
			wantInput: intPtr(50), wantOutput: intPtr(5), wantRead: &zero,
			wantStatus: store.CacheStatusReported, wantSemantics: store.InputSemanticsTotalIncludesCache,
			wantLogical: 50, wantEligible: true,
		},
		{
			name:  "kin provider omits cache",
			agent: "kin", model: "gpt-test",
			payload:   `{"source":"kin","prompt_tokens":50,"completion_tokens":5,"cached_tokens":0,"cache_read_reported":false}`,
			wantInput: intPtr(50), wantOutput: intPtr(5),
			wantStatus: store.CacheStatusUnknown, wantSemantics: store.InputSemanticsTotalIncludesCache,
			wantLogical: 50, wantEligible: false,
		},
		{
			name:      "unsupported cache",
			agent:     "grok",
			payload:   `{"source":"grok","input_tokens":12,"output_tokens":3,"cache_status":"unsupported","input_semantics":"unknown"}`,
			wantInput: intPtr(12), wantOutput: intPtr(3),
			wantStatus: store.CacheStatusUnsupported, wantSemantics: store.InputSemanticsUnknown,
			wantLogical: 12, wantEligible: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			record, err := NormalizeUsage(tt.agent, tt.model, json.RawMessage(tt.payload))
			if err != nil {
				t.Fatal(err)
			}
			assertOptionalInt(t, "input", record.InputTokens, tt.wantInput)
			assertOptionalInt(t, "output", record.OutputTokens, tt.wantOutput)
			assertOptionalInt(t, "reasoning", record.ReasoningOutputTokens, tt.wantReasoning)
			assertOptionalInt(t, "cache read", record.CacheReadTokens, tt.wantRead)
			assertOptionalInt(t, "cache write", record.CacheWriteTokens, tt.wantWrite)
			if record.CacheStatus != tt.wantStatus || record.InputSemantics != tt.wantSemantics {
				t.Fatalf("status/semantics = %s/%s, want %s/%s", record.CacheStatus, record.InputSemantics, tt.wantStatus, tt.wantSemantics)
			}
			logical, eligible := UsageLogicalInput(record)
			if logical != tt.wantLogical || eligible != tt.wantEligible {
				t.Fatalf("logical input = %d eligible=%v, want %d/%v", logical, eligible, tt.wantLogical, tt.wantEligible)
			}
		})
	}
}

func TestNormalizeUsageRejectsInvalid(t *testing.T) {
	for _, payload := range []string{
		`not json`,
		`{"source":"codex","input_tokens":-1}`,
		`{"source":"codex"}`,
	} {
		if _, err := NormalizeUsage("codex", "m", json.RawMessage(payload)); err == nil {
			t.Fatalf("payload %q accepted", payload)
		}
	}
}

func intPtr(v int) *int { return &v }

func assertOptionalInt(t *testing.T, name string, got, want *int) {
	t.Helper()
	if got == nil || want == nil {
		if got != nil || want != nil {
			t.Fatalf("%s = %v, want %v", name, got, want)
		}
		return
	}
	if *got != *want {
		t.Fatalf("%s = %d, want %d", name, *got, *want)
	}
}
