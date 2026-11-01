package main

import (
	"strings"
	"testing"
)

func TestParseSSEFrames(t *testing.T) {
	input := strings.Join([]string{
		"retry: 3000",
		"",
		": ping",
		"",
		"event: event",
		`data: {"kind":"event","data":{"task_id":"t1","seq":1}}`,
		"",
		"event: task_update",
		"data: {\"kind\":\"task_update\",",
		`data: "data":{"id":"t1"}}`,
		"",
	}, "\n")

	var frames []SSEFrame
	if err := ParseSSE(strings.NewReader(input), func(f SSEFrame) error {
		frames = append(frames, f)
		return nil
	}); err != nil {
		t.Fatalf("ParseSSE: %v", err)
	}

	if len(frames) != 4 {
		t.Fatalf("got %d frames, want 4: %+v", len(frames), frames)
	}
	if frames[0].Retry != "3000" || frames[0].Event != "" {
		t.Errorf("retry frame decoded as %+v", frames[0])
	}
	if frames[1].Comment != "ping" {
		t.Errorf("comment frame decoded as %+v", frames[1])
	}
	if frames[2].Event != "event" || frames[2].Data == "" {
		t.Errorf("event frame decoded as %+v", frames[2])
	}
	if frames[3].Event != "task_update" || !strings.Contains(frames[3].Data, "\n") {
		t.Errorf("multi-line data frame decoded as %+v", frames[3])
	}

	msg, err := DecodeWSMessage(frames[2].Data)
	if err != nil {
		t.Fatalf("DecodeWSMessage: %v", err)
	}
	if msg.Kind != "event" || !strings.Contains(string(msg.Data), `"seq":1`) {
		t.Errorf("union decoded as %+v (data %s)", msg, msg.Data)
	}
}

func TestParseSSECRLF(t *testing.T) {
	input := "event: event\r\ndata: {}\r\n\r\n"
	var got []SSEFrame
	if err := ParseSSE(strings.NewReader(input), func(f SSEFrame) error {
		got = append(got, f)
		return nil
	}); err != nil {
		t.Fatalf("ParseSSE: %v", err)
	}
	if len(got) != 1 || got[0].Event != "event" || got[0].Data != "{}" {
		t.Fatalf("CRLF framing decoded as %+v", got)
	}
}

// A comment is not part of an event: `: ping` arriving inside an event frame
// must not turn that frame into a comment-only heartbeat.
func TestParseSSECommentInsideDataFrameKeepsEvent(t *testing.T) {
	input := ": ping\nevent: event\ndata: {}\n\n: heartbeat\n\n"
	var got []SSEFrame
	if err := ParseSSE(strings.NewReader(input), func(f SSEFrame) error {
		got = append(got, f)
		return nil
	}); err != nil {
		t.Fatalf("ParseSSE: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d frames, want 2: %+v", len(got), got)
	}
	if got[0].Event != "event" || got[0].Data != "{}" {
		t.Errorf("comment suppressed the event frame: %+v", got[0])
	}
	if got[1].Comment != "heartbeat" || got[1].Event != "" {
		t.Errorf("comment-only frame decoded as %+v", got[1])
	}
}
