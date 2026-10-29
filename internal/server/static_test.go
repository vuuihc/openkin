package server

import "testing"

// The console's cache policy. What is pinned here is the pair of mistakes that
// cost the most: a hashed asset served with a revalidating header (every
// screen load re-downloads the bundle), and a hand-written root file served
// with an immutable one (a fixed service worker never reaches the browser that
// needs it).
func TestStaticCacheControl(t *testing.T) {
	cases := []struct {
		path       string
		serveIndex bool
		want       string
	}{
		{"/assets/index-DnLkFirt.js", false, "public, max-age=31536000, immutable"},
		{"/assets/index-DiEZdwgh.css", false, "public, max-age=31536000, immutable"},
		{"/", true, "no-cache"},
		{"/index.html", true, "no-cache"},
		{"/sessions", true, "no-cache"},
		{"/manifest.webmanifest", false, "no-cache"},
		{"/sw.js", false, "no-cache"},
		{"/icons/icon-192.png", false, ""},
	}
	for _, tc := range cases {
		if got := staticCacheControl(tc.path, tc.serveIndex); got != tc.want {
			t.Errorf("staticCacheControl(%q, %v) = %q, want %q", tc.path, tc.serveIndex, got, tc.want)
		}
	}
}
