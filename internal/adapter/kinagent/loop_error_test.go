package kinagent

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestFriendlyErrorMessageCanceled(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"context.Canceled", context.Canceled, "canceled"},
		{"wrapped cancel", fmt.Errorf("chat: %w", context.Canceled), "canceled"},
		{"string cancel", errors.New("context canceled"), "canceled"},
		{
			"http2 stream cancel",
			errors.New("stream error: stream ID 3; CANCEL; received from peer"),
			"canceled",
		},
		{
			"http2 cancel case",
			errors.New("read stream: stream error: stream ID 1; Cancel; received from peer"),
			"canceled",
		},
		{"deadline", context.DeadlineExceeded, "timed out"},
		{"other", errors.New("provider HTTP 500 boom"), "provider HTTP 500 boom"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := friendlyErrorMessage(tc.err)
			if got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}
