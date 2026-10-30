package kinagent

import (
	"context"
	"errors"
	"fmt"
	"strings"
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

// The reconnect line is "Provider <reason> — reconnecting …". A reason that
// begins with the same word read "Provider provider HTTP 520", the reason used
// to be the provider's whole error page, and a long gateway URL pushed the
// actual cause past the line's budget.
func TestProviderRetryHintDoesNotStutter(t *testing.T) {
	reason := summarizeProviderRetryReason(errors.New(
		"provider HTTP 520 (https://provider.example/v1/chat/completions): cloudflare/origin unreachable",
	))
	if strings.HasPrefix(strings.ToLower(reason), "provider ") {
		t.Fatalf("reason repeats the line's own prefix: %q", reason)
	}
	if reason != "HTTP 520: cloudflare/origin unreachable" {
		t.Fatalf("reason lost its cause: %q", reason)
	}

	// A capital-P producer must not stutter either.
	if upper := summarizeProviderRetryReason(errors.New("Provider HTTP 502 (x): bad gateway")); strings.HasPrefix(strings.ToLower(upper), "provider ") {
		t.Fatalf("capitalised reason repeats the prefix: %q", upper)
	}

	// A URL longer than the budget must not hide the sentence after it. 520
	// has no short label in the switch, so it takes the path this fixes.
	long := "provider HTTP 520 (https://gateway." + strings.Repeat("sub.", 40) + "example/v1/chat/completions): cloudflare/origin unreachable"
	if got := summarizeProviderRetryReason(errors.New(long)); got != "HTTP 520: cloudflare/origin unreachable" {
		t.Fatalf("long URL ate the cause: %q", got)
	}

	// A URL that itself contains parentheses must not truncate the reason.
	parenthesised := "provider HTTP 520 (https://host.example/path(foo)/v1/chat/completions): cloudflare/origin unreachable"
	if got := summarizeProviderRetryReason(errors.New(parenthesised)); got != "HTTP 520: cloudflare/origin unreachable" {
		t.Fatalf("parenthesised URL ate the cause: %q", got)
	}

	if got := summarizeProviderRetryReason(errors.New("provider HTTP 524 (https://provider.example): gateway timeout")); got != "gateway timeout (HTTP 524)" {
		t.Fatalf("known status: %q", got)
	}

	unknown := summarizeProviderRetryReason(errors.New("provider " + strings.Repeat("x", 200)))
	if !strings.HasPrefix(unknown, "x") || len(unknown) > 123 {
		t.Fatalf("unknown reason is not bounded: %d bytes, %q", len(unknown), unknown)
	}
}
