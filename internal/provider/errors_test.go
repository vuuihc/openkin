package provider

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

const errorTestURL = "https://provider.example/v1/chat/completions"

const errorPage = `<!DOCTYPE html>
<html>
<head><title>provider.example | 520: Web server is returning an unknown error</title>
<style>body{margin:0;padding:0}</style></head>
<body><h1>Origin unreachable</h1><script>window.__cf={}</script></body>
</html>`

// The error a failed call leaves behind is stored in the task, pushed to a
// phone, and shown to whoever the conversation is shared with. A gateway's
// HTML error page is not part of that message: the status and its hint already
// say what happened, and the page is a wall of doctypes and inline styles that
// buries the sentence. A provider's own JSON message is part of it.
func TestProviderHTTPErrorKeepsTheMessageDropsThePage(t *testing.T) {
	tests := []struct {
		name string
		code int
		body string
		want string
	}{
		{
			name: "an OpenAI error envelope is a message",
			code: 400,
			body: `{"error":{"message":"The model does not exist","type":"invalid_request_error"}}`,
			want: "provider HTTP 400 (" + errorTestURL + "): The model does not exist",
		},
		{
			name: "an Anthropic error envelope is a message",
			code: 529,
			body: `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`,
			want: "provider HTTP 529 (" + errorTestURL + "): Overloaded",
		},
		{
			name: "a bare message field is a message",
			code: 429,
			body: `{"message":"quota exhausted"}`,
			want: "provider HTTP 429 (" + errorTestURL + "): rate limited — quota exhausted",
		},
		{
			name: "an error string is a message",
			code: 403,
			body: `{"error":"key revoked"}`,
			want: "provider HTTP 403 (" + errorTestURL + "): key revoked",
		},
		{
			name: "a clean message survives a broken sibling",
			code: 400,
			body: `{"error":{"message":"The model does not exist"},"detail":[]}`,
			want: "provider HTTP 400 (" + errorTestURL + "): The model does not exist",
		},
		{
			name: "a number cannot hide the error envelope",
			code: 429,
			body: `{"message":123,"error":{"message":"quota exhausted"}}`,
			want: "provider HTTP 429 (" + errorTestURL + "): rate limited — quota exhausted",
		},
		{
			name: "a message may mention markup",
			code: 400,
			body: `{"error":{"message":"Invalid content: expected text but got <html> markup"}}`,
			want: "provider HTTP 400 (" + errorTestURL + "): Invalid content: expected text but got <html> markup",
		},
		{
			name: "plain markup words are text, not a page",
			code: 400,
			body: "unexpected token <header> in tool schema",
			want: "provider HTTP 400 (" + errorTestURL + "): unexpected token <header> in tool schema",
		},
		{
			name: "a gateway page is not a message",
			code: 520,
			body: errorPage,
			want: "provider HTTP 520 (" + errorTestURL + "): cloudflare/origin unreachable",
		},
		{
			name: "a page names itself when the status has no hint",
			code: 403,
			body: `<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>blocked</body></html>`,
			want: "provider HTTP 403 (" + errorTestURL + "): Attention Required! | Cloudflare",
		},
		{
			name: "a page without a title leaves the status",
			code: 403,
			body: `<html><body>go away</body></html>`,
			want: "provider HTTP 403 (" + errorTestURL + ")",
		},
		{
			name: "an XML error document is text",
			code: 403,
			body: `<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>`,
			want: "provider HTTP 403 (" + errorTestURL + "): <?xml version=\"1.0\"?><Error><Code>AccessDenied</Code></Error>",
		},
		{
			name: "a page behind a leading comment is still a page",
			code: 403,
			body: "<!-- blocked by policy -->\n<!DOCTYPE html><html><head><title>Blocked by policy</title></head></html>",
			want: "provider HTTP 403 (" + errorTestURL + "): Blocked by policy",
		},
		{
			name: "a declaration then a comment still opens a page",
			code: 403,
			body: `<?xml version="1.0"?><!-- c --><!DOCTYPE html><html><head><title>Real</title></head></html>`,
			want: "provider HTTP 403 (" + errorTestURL + "): Real",
		},
		{
			name: "a decoy title inside a comment is not the page's title",
			code: 403,
			body: `<!--[if lt IE 9]><title>Legacy</title><![endif]--><html><head><title>Real</title></head></html>`,
			want: "provider HTTP 403 (" + errorTestURL + "): Real",
		},
		{
			name: "an unterminated comment leaves no message",
			code: 403,
			body: `<!-- never closed <!DOCTYPE html><html><head><title>Real</title></head></html>`,
			want: "provider HTTP 403 (" + errorTestURL + ")",
		},
		{
			name: "an XML declaration before a page does not hide it",
			code: 403,
			body: `<?xml version="1.0"?><!DOCTYPE html><html><head><title>Blocked</title></head></html>`,
			want: "provider HTTP 403 (" + errorTestURL + "): Blocked",
		},
		{
			name: "a hinted status says only its hint, comment or not",
			code: 520,
			body: "<!-- blocked by policy -->\n<!DOCTYPE html><html><head><title>Blocked by policy</title></head></html>",
			want: "provider HTTP 520 (" + errorTestURL + "): cloudflare/origin unreachable",
		},
		{
			name: "plain text keeps its words on one line",
			code: 503,
			body: "upstream\n\t overloaded",
			want: "provider HTTP 503 (" + errorTestURL + "): service unavailable — upstream overloaded",
		},
		{
			name: "a body that repeats the hint is said once",
			code: 429,
			body: "rate limited",
			want: "provider HTTP 429 (" + errorTestURL + "): rate limited",
		},
		{
			name: "an empty body leaves the hint",
			code: 502,
			body: " \n ",
			want: "provider HTTP 502 (" + errorTestURL + "): bad gateway",
		},
		{
			name: "a code with no hint and no body leaves the status",
			code: 400,
			body: "",
			want: "provider HTTP 400 (" + errorTestURL + ")",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := httpStatusErr(tc.code, errorTestURL, tc.body).Error()
			if got != tc.want {
				t.Fatalf("got  %q\nwant %q", got, tc.want)
			}
		})
	}

	t.Run("an already extracted message is not re-classified", func(t *testing.T) {
		// The call sites that already parsed the envelope hand the message in
		// on its own; a message that talks about markup is text, not a page.
		for _, message := range []string{
			"Invalid content: expected text but got <html> markup",
			"unexpected token <header> in tool schema",
		} {
			if got := providerErrorMessage(message); got != message {
				t.Fatalf("message %q became %q", message, got)
			}
		}
		if got := providerErrorMessage(errorPage); got != "" {
			t.Fatalf("a page was kept as a message: %q", got)
		}
	})

	t.Run("case folding cannot move a title's offsets", func(t *testing.T) {
		// U+023A lowercases to U+2C65 and grows from 2 bytes to 3. A title
		// search that maps offsets from a lowercased copy back onto the body
		// slices out of range and takes the daemon down.
		expanding := strings.Repeat("\u023a", 120)
		got := httpStatusErr(403, errorTestURL, "<html>"+expanding+"<title>Blocked</title></html>").Error()
		if got != "provider HTTP 403 ("+errorTestURL+"): Blocked" {
			t.Fatalf("title before expanding runes: %q", got)
		}
		inside := httpStatusErr(403, errorTestURL, "<html><title>"+expanding+"Blocked</title></html>").Error()
		if !strings.Contains(inside, "Ⱥ") {
			t.Fatalf("title after expanding runes: %q", inside)
		}
	})

	t.Run("a gateway page leaves no markup behind", func(t *testing.T) {
		got := httpStatusErr(520, errorTestURL, errorPage).Error()
		for _, marker := range []string{"<", "doctype", "html", "style", "script"} {
			if strings.Contains(strings.ToLower(got), marker) {
				t.Fatalf("markup marker %q leaked into the error: %q", marker, got)
			}
		}
	})

	t.Run("a long body is bounded", func(t *testing.T) {
		got := httpStatusErr(500, errorTestURL, strings.Repeat("x", 2000)).Error()
		if want := len("provider HTTP 500 (" + errorTestURL + "): upstream internal error — "); len(got) > want+303 {
			t.Fatalf("error is %d bytes, want at most %d", len(got), want+303)
		}
		if !strings.HasSuffix(got, "…") {
			t.Fatalf("the cut is not marked: %q", got)
		}
		if !strings.Contains(got, "upstream internal error") {
			t.Fatalf("the cut swallowed the hint: %q", got)
		}
	})

	t.Run("a multibyte body is cut on a rune boundary", func(t *testing.T) {
		got := httpStatusErr(500, errorTestURL, strings.Repeat("失", 400)).Error()
		if !utf8.ValidString(got) {
			t.Fatalf("the error is not valid UTF-8: %q", got)
		}
		if !strings.HasSuffix(got, "…") || !strings.Contains(got, "失") {
			t.Fatalf("unexpected cut: %q", got)
		}
	})
}

func TestFinalProviderErrorNamesTheCauseOnce(t *testing.T) {
	cause := httpStatusErr(520, errorTestURL, "<!DOCTYPE html><html><body>origin down</body></html>")

	got := formatFinalProviderErr(cause, 5).Error()
	want := "provider HTTP 520 (" + errorTestURL + "): cloudflare/origin unreachable (failed after 5 attempts)"
	if got != want {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
	if n := strings.Count(strings.ToLower(got), "cloudflare/origin unreachable"); n != 1 {
		t.Fatalf("the cause is named %d times: %q", n, got)
	}
	// Retry classification reads this text back.
	if code, ok := parseProviderHTTPStatus(strings.ToLower(got)); !ok || code != 520 {
		t.Fatalf("final error no longer parses as a 520: %q", got)
	}

	// One attempt has no retry story to tell.
	if single := formatFinalProviderErr(cause, 1).Error(); single != cause.Error() {
		t.Fatalf("a single attempt rewrote its error: %q", single)
	}
	// A failure that is not an HTTP status keeps its own shape.
	if transport := formatFinalProviderErr(errors.New("connection reset by peer"), 3).Error(); transport != "provider failed after 3 attempts: connection reset by peer" {
		t.Fatalf("transport failure: %q", transport)
	}
	if timeout := formatFinalProviderErr(errors.New("provider request timeout: context deadline exceeded"), 5).Error(); !strings.HasPrefix(timeout, "provider timeout (failed after 5 attempts; last: ") {
		t.Fatalf("timeout failure: %q", timeout)
	}
	// An already annotated error is not wrapped again.
	annotated := errors.New("provider failed after 2 attempts")
	if again := formatFinalProviderErr(annotated, 5).Error(); again != annotated.Error() {
		t.Fatalf("annotated error was rewrapped: %q", again)
	}
	// A hint the body shouted in capitals is still recognised as said once.
	shouting := httpStatusErr(429, errorTestURL, `{"message":"RATE LIMITED"}`)
	if single := formatFinalProviderErr(shouting, 1).Error(); strings.HasPrefix(single, "rate limited — ") {
		t.Fatalf("a shouted hint was repeated: %q", single)
	}
}

func TestDecodeErrorsDoNotQuoteThePage(t *testing.T) {
	if got := bodyExcerpt(errorPage, 200); got != "an HTML error page" {
		t.Fatalf("page excerpt: %q", got)
	}
	if got := bodyExcerpt("  ", 200); got != "an empty body" {
		t.Fatalf("empty excerpt: %q", got)
	}
	if got := bodyExcerpt("not json at all", 200); got != "not json at all" {
		t.Fatalf("text excerpt: %q", got)
	}
}

// The whole path, not the helper: a real retry loop against a gateway that
// answers 520 with its own page must end in one readable line.
func TestChatFailureDropsTheGatewaysPage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(520)
		_, _ = io.WriteString(w, errorPage)
	}))
	defer srv.Close()

	attempts, backoff := chatMaxAttempts, chatBackoffFn
	chatMaxAttempts, chatBackoffFn = 3, func(int) time.Duration { return 0 }
	defer func() { chatMaxAttempts, chatBackoffFn = attempts, backoff }()

	c, err := NewClient(Config{
		Kind:    "openai-compatible",
		BaseURL: srv.URL + "/v1",
		APIKey:  "sk-test",
		Model:   "test-model",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.Chat(context.Background(), ChatRequest{
		Messages: []Message{{Role: RoleUser, Content: "hi"}},
	})
	if err == nil {
		t.Fatal("a 520 answered as if it succeeded")
	}
	want := "provider HTTP 520 (" + srv.URL + "/v1/chat/completions): cloudflare/origin unreachable (failed after 3 attempts)"
	if err.Error() != want {
		t.Fatalf("got  %q\nwant %q", err.Error(), want)
	}
	if strings.Contains(err.Error(), "<") {
		t.Fatalf("markup leaked into the task's error: %q", err.Error())
	}
}
