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
		{
			"unknown model 404",
			errors.New(`provider HTTP 404 (https://grok-proxy.example.com/v1/chat/completions): {"code":"not-found","error":"The model opus does not exist or your team does not have access to it."}`),
			`provider HTTP 404 (https://grok-proxy.example.com/v1/chat/completions): {"code":"not-found","error":"The model opus does not exist or your team does not have access to it."}` +
				"\n\nHint: Kin uses the Cognition provider model from Settings, not the host Agent's model. " +
				"Set provider.model to a model your endpoint supports, or delegate with @kin[model-id].",
		},
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
