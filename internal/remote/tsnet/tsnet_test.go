package tsnet

import (
	"context"
	"errors"
	"net"
	"testing"

	"github.com/vuuihc/kin/internal/remote"
)

func TestBuildServerPlumbsControlURL(t *testing.T) {
	cfg := remote.Config{
		Hostname:   "kin",
		StateDir:   t.TempDir(),
		ControlURL: "https://headscale.example.com",
		Port:       7777,
	}
	s := BuildServer(cfg)
	if s.ControlURL() != "https://headscale.example.com" {
		t.Fatalf("ControlURL = %q", s.ControlURL())
	}
	// Must not perform network I/O just by constructing.
	// (BuildServer only allocates *tsnet.Server fields.)
}

func TestValidateFlagsFunnelWithControlURL(t *testing.T) {
	err := ValidateFlags(true, "https://example.com")
	if err == nil {
		t.Fatal("expected error for --funnel + control URL")
	}
	if !containsAll(err.Error(), "funnel", "control") && !containsAll(err.Error(), "Funnel", "control") {
		// message should mention both concepts
		if !contains(err.Error(), "funnel") && !contains(err.Error(), "Funnel") {
			t.Fatalf("error should mention funnel: %v", err)
		}
	}

	if err := ValidateFlags(true, ""); err != nil {
		t.Fatalf("funnel alone: %v", err)
	}
	if err := ValidateFlags(false, "https://example.com"); err != nil {
		t.Fatalf("control alone: %v", err)
	}
}

func TestTransportListenUsesFactoryNoNetwork(t *testing.T) {
	var upCalled, listenCalled bool
	fake := &fakeServer{
		control: "https://hs.example",
		url:     "http://kin.tailnet.ts.net",
		listen: func(network, addr string) (net.Listener, error) {
			listenCalled = true
			return &stubListener{}, nil
		},
		up: func(ctx context.Context) error {
			upCalled = true
			return nil
		},
	}
	tr := &Transport{
		ServerFactory: func(cfg remote.Config) Server {
			if cfg.ControlURL != "https://hs.example" {
				t.Fatalf("factory cfg ControlURL = %q", cfg.ControlURL)
			}
			return fake
		},
	}
	ln, err := tr.Listen(context.Background(), remote.Config{
		Port:       7777,
		ControlURL: "https://hs.example",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if !upCalled || !listenCalled {
		t.Fatalf("up=%v listen=%v", upCalled, listenCalled)
	}
	if tr.Server().ControlURL() != "https://hs.example" {
		t.Fatal("server control URL not retained")
	}
}

func TestTransportFunnelPath(t *testing.T) {
	var funnelCalled bool
	fake := &fakeServer{
		funnel: func(network, addr string) (net.Listener, error) {
			funnelCalled = true
			if addr != ":443" {
				t.Fatalf("funnel addr = %s", addr)
			}
			return &stubListener{}, nil
		},
		up: func(ctx context.Context) error { return nil },
	}
	tr := &Transport{ServerFactory: func(remote.Config) Server { return fake }}
	ln, err := tr.Listen(context.Background(), remote.Config{Funnel: true, Port: 7777})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if !funnelCalled {
		t.Fatal("ListenFunnel not called")
	}
}

func TestTransportUpError(t *testing.T) {
	fake := &fakeServer{
		up: func(ctx context.Context) error { return errors.New("no network") },
	}
	tr := &Transport{ServerFactory: func(remote.Config) Server { return fake }}
	_, err := tr.Listen(context.Background(), remote.Config{Port: 7777})
	if err == nil {
		t.Fatal("expected up error")
	}
}

type fakeServer struct {
	control string
	url     string
	up      func(ctx context.Context) error
	listen  func(network, addr string) (net.Listener, error)
	funnel  func(network, addr string) (net.Listener, error)
	closed  bool
}

func (f *fakeServer) Up(ctx context.Context) error {
	if f.up != nil {
		return f.up(ctx)
	}
	return nil
}
func (f *fakeServer) Listen(network, addr string) (net.Listener, error) {
	if f.listen != nil {
		return f.listen(network, addr)
	}
	return &stubListener{}, nil
}
func (f *fakeServer) ListenFunnel(network, addr string) (net.Listener, error) {
	if f.funnel != nil {
		return f.funnel(network, addr)
	}
	return &stubListener{}, nil
}
func (f *fakeServer) TailnetURL() string  { return f.url }
func (f *fakeServer) FunnelURL() string   { return "" }
func (f *fakeServer) Close() error        { f.closed = true; return nil }
func (f *fakeServer) ControlURL() string  { return f.control }

type stubListener struct{}

func (s *stubListener) Accept() (net.Conn, error) { return nil, net.ErrClosed }
func (s *stubListener) Close() error              { return nil }
func (s *stubListener) Addr() net.Addr            { return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 7777} }

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 ||
		(len(s) > 0 && (func() bool {
			for i := 0; i+len(sub) <= len(s); i++ {
				if s[i:i+len(sub)] == sub {
					return true
				}
			}
			return false
		})()))
}

func containsAll(s string, parts ...string) bool {
	for _, p := range parts {
		if !contains(s, p) {
			return false
		}
	}
	return true
}
