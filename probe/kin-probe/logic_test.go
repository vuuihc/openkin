package main

import (
	"testing"
)

func TestMissingSeqs(t *testing.T) {
	full := map[int64]TaskEvent{1: {Seq: 1}, 2: {Seq: 2}, 5: {Seq: 5}}
	union := map[int64]TaskEvent{2: {Seq: 2}, 5: {Seq: 5}}
	got := missingSeqs(full, union)
	if len(got) != 1 || got[0] != 1 {
		t.Fatalf("missingSeqs = %v, want [1]", got)
	}
	if got := missingSeqs(full, full); len(got) != 0 {
		t.Fatalf("missingSeqs(identical) = %v, want empty", got)
	}
}

func TestFinalAssistantTextOrdersBySeqAndSkipsPartials(t *testing.T) {
	events := map[int64]TaskEvent{
		4: {Seq: 4, Type: "message", Payload: []byte(`{"role":"assistant","partial":true,"content":[{"type":"text","text":"del"}]}`)},
		3: {Seq: 3, Type: "message", Payload: []byte(`{"role":"assistant","partial":false,"content":[{"type":"text","text":"first"}]}`)},
		2: {Seq: 2, Type: "message", Payload: []byte(`{"role":"user","partial":false,"content":[{"type":"text","text":"ignored"}]}`)},
		5: {Seq: 5, Type: "message", Payload: []byte(`{"role":"assistant","partial":false,"content":[{"type":"text","text":"second"}]}`)},
	}
	got := finalAssistantText(events)
	if len(got) != 2 || got[0] != "first" || got[1] != "second" {
		t.Fatalf("finalAssistantText = %v, want [first second]", got)
	}
}

func TestIsTerminal(t *testing.T) {
	for status, want := range map[string]bool{
		"running": false, "queued": false, "": false,
		"succeeded": true, "failed": true, "canceled": true,
	} {
		if got := isTerminal(status); got != want {
			t.Errorf("isTerminal(%q) = %v, want %v", status, got, want)
		}
	}
}

func TestIsFinal(t *testing.T) {
	for status, want := range map[string]bool{
		"succeeded": true, "failed": true, "canceled": true, "cancelled": true,
		"running": false, "waiting_approval": false, "": false,
	} {
		if got := isFinal(status); got != want {
			t.Errorf("isFinal(%q) = %v, want %v", status, got, want)
		}
	}
}

func TestErrorMessage(t *testing.T) {
	ev := TaskEvent{Payload: []byte(`{"message":"task execution directory is unavailable"}`)}
	if got := errorMessage(ev); got != "task execution directory is unavailable" {
		t.Fatalf("errorMessage = %q", got)
	}
}
