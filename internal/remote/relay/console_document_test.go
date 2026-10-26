package relay

import (
	"io/fs"
	"regexp"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/web"
)

// The relay forwards the console document byte for byte and lets the worker's
// cookie pay for whatever the browser asks for next. Almost every reference is
// covered without being asked: a script, a stylesheet, an icon and an XHR are all
// fetched with same-origin credentials. The web manifest is the exception — its
// request is defined as a CORS fetch whose credentials are omitted unless the
// link carries `crossorigin="use-credentials"`, even when the manifest sits on
// the same origin. The relay used to append `?room=&key=` to every root-absolute
// reference, and that query is what carried the manifest; when the rewrite went
// away the manifest was left with no credential at all and the worker answered
// 400 to it, which costs the install metadata and its icons and says nothing on
// the page. This is the one reference in the shipped document that cannot be
// fixed anywhere but here.
//
// It reads the document the daemon actually serves — the embedded build output —
// rather than a fixture, because the failure only ever existed in that file: the
// link is written in ui/index.html and reaches the relay through `npm run
// build`, so the attribute has to survive the build as well as the review.
func TestShippedConsoleNamesItsManifestWithCredentials(t *testing.T) {
	sub, err := fs.Sub(web.FS, "dist")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := fs.ReadFile(sub, "index.html")
	if err != nil {
		t.Fatal(err)
	}

	links := regexp.MustCompile(`(?is)<link\b[^>]*\brel\s*=\s*["']?manifest["']?[^>]*>`).
		FindAllString(string(doc), -1)
	if len(links) != 1 {
		t.Fatalf("index.html names %d manifest links, want exactly one: %q", len(links), links)
	}
	if link := links[0]; !strings.Contains(link, `crossorigin="use-credentials"`) {
		t.Fatalf("manifest link %q fetches without credentials: the relay no longer "+
			"rewrites the document, so this request would reach the worker carrying "+
			"neither a cookie nor a query and be refused", link)
	}

	// The href also has to land on the daemon the cookie was set for. A
	// root-absolute path does; `//host/path` is another origin, where the cookie
	// is not sent and the worker is not the one answering.
	href := regexp.MustCompile(`(?is)\bhref\s*=\s*["']([^"']*)["']`).FindStringSubmatch(links[0])
	if href == nil {
		t.Fatalf("manifest link %q names no href", links[0])
	}
	if !strings.HasPrefix(href[1], "/") || strings.HasPrefix(href[1], "//") {
		t.Fatalf("manifest href %q is not a root-absolute path on the console's own origin", href[1])
	}
	if _, err := fs.Stat(sub, strings.TrimPrefix(href[1], "/")); err != nil {
		t.Fatalf("manifest href %q is not a file the console serves: %v", href[1], err)
	}
}
