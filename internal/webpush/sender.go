package webpush

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"time"
)

// Payload is the notification a service worker shows. It is JSON rather than
// plain text so the worker can route the tap: the URL is the same deep link
// the Bark and ntfy channels already carry.
type Payload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url,omitempty"`
}

// Subscription is one browser's push endpoint with the keys it subscribed
// with.
type Subscription struct {
	ID       string
	Endpoint string
	P256DH   string
	Auth     string
}

// Store persists subscriptions. Deletion is part of delivery: a push service
// that answers 404 or 410 has told us the subscription is gone for good, and
// keeping the row would fail on every following message.
type Store interface {
	ListPushSubscriptions(ctx context.Context) ([]Subscription, error)
	DeletePushSubscription(ctx context.Context, id string) error
}

// Result is the outcome of one delivery attempt, shaped like the other
// notification channels so the settings page can show one list.
type Result struct {
	OK     bool
	Status string
	Error  string
}

// Service sends push messages to every stored subscription.
type Service struct {
	Store   Store
	Keys    *Keys
	Subject string
	Client  *http.Client
	Now     func() time.Time
}

func (s *Service) client() *http.Client {
	if s.Client != nil {
		return s.Client
	}
	return defaultClient
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// defaultClient refuses to connect anywhere private.
//
// A subscription endpoint arrives from the browser, and the daemon posts to it
// on a timer with no one watching. Push services are public by definition, so
// the honest set of addresses is "the internet"; refusing loopback, private
// and link-local targets keeps a forged subscription from turning the daemon
// into a probe of the machine's own network.
var defaultClient = &http.Client{
	Timeout: 10 * time.Second,
	// A push service accepts the POST at the endpoint it published. Following
	// a redirect would let an endpoint name somewhere else to send to — the
	// body is ciphertext, but the request is still this daemon's, from its
	// address, on somebody else's instruction.
	CheckRedirect: refuseRedirect,
	Transport: &http.Transport{
		DialContext: (&net.Dialer{
			Timeout: 5 * time.Second,
			Control: func(network, address string, _ syscall.RawConn) error {
				host, _, err := net.SplitHostPort(address)
				if err != nil {
					return err
				}
				ip := net.ParseIP(host)
				if ip == nil {
					// A literal the standard library will not parse (a scoped
					// IPv6 address, say) is not an address this daemon can
					// judge; refusing is the only safe answer.
					return fmt.Errorf("webpush: refusing to connect to %q", host)
				}
				if !publicAddr(ip) {
					return fmt.Errorf("webpush: refusing to connect to %s", ip)
				}
				return nil
			},
		}).DialContext,
	},
}

// publicAddr reports whether ip is an address the public internet could hold.
//
// Deny by default: the set of ranges that are "not the internet" keeps
// growing, and a missed one is a request this daemon makes into somebody's
// private network. Beyond what the standard library already knows (loopback,
// multicast, link-local, unspecified, RFC 1918, fc00::/7) that includes the
// carrier-grade NAT range — which is also the Tailscale range, in a repo that
// ships --tailscale — benchmarking space, IETF protocol assignments, "this
// network", and the NAT64 prefix that can wrap a private IPv4 address.
func publicAddr(ip net.IP) bool {
	if !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		switch {
		case v4[0] == 100 && v4[1]&0xc0 == 64: // 100.64.0.0/10 CGNAT / Tailscale
			return false
		case v4[0] == 198 && v4[1]&0xfe == 18: // 198.18.0.0/15 benchmarking
			return false
		case v4[0] == 192 && v4[1] == 0 && v4[2] == 0: // 192.0.0.0/24 IETF
			return false
		case v4[0] == 0: // 0.0.0.0/8 "this network"
			return false
		}
		return true
	}
	// 64:ff9b::/96 wraps an IPv4 address; do not let it smuggle a private one.
	if len(ip) == net.IPv6len && ip[0] == 0x00 && ip[1] == 0x64 && ip[2] == 0xff && ip[3] == 0x9b {
		return false
	}
	return true
}

// refuseRedirect is the redirect policy above, named so a test can drive it
// through a real request without the private-address dialer in the way.
func refuseRedirect(*http.Request, []*http.Request) error {
	return errors.New("webpush: push services do not redirect")
}

// Send delivers p to every subscription and reports one result per endpoint.
// A subscription that the push service has retired is deleted; everything
// else is left for the next message.
func (s *Service) Send(ctx context.Context, p Payload) []Result {
	if s == nil || s.Store == nil || s.Keys == nil {
		return nil
	}
	subs, err := s.Store.ListPushSubscriptions(ctx)
	if err != nil || len(subs) == 0 {
		return nil
	}
	body, err := json.Marshal(p)
	if err != nil {
		return []Result{{Error: err.Error()}}
	}
	results := make([]Result, 0, len(subs))
	for _, sub := range subs {
		results = append(results, s.sendOne(ctx, sub, body))
	}
	return results
}

func (s *Service) sendOne(ctx context.Context, sub Subscription, payload []byte) Result {
	if _, err := audienceOf(sub.Endpoint); err != nil {
		s.drop(ctx, sub)
		return Result{Error: err.Error()}
	}
	p256dh, err := base64.RawURLEncoding.DecodeString(sub.P256DH)
	if err != nil {
		s.drop(ctx, sub)
		return Result{Error: "webpush: bad p256dh: " + err.Error()}
	}
	auth, err := base64.RawURLEncoding.DecodeString(sub.Auth)
	if err != nil {
		s.drop(ctx, sub)
		return Result{Error: "webpush: bad auth: " + err.Error()}
	}
	encrypted, err := Encrypt(p256dh, auth, payload)
	if err != nil {
		s.drop(ctx, sub)
		return Result{Error: err.Error()}
	}
	authHeader, err := s.Keys.Authorization(sub.Endpoint, s.Subject, s.now())
	if err != nil {
		return Result{Error: err.Error()}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, sub.Endpoint, bytes.NewReader(encrypted))
	if err != nil {
		s.drop(ctx, sub)
		return Result{Error: err.Error()}
	}
	req.Header.Set("Authorization", authHeader)
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("TTL", "3600")
	req.Header.Set("Urgency", "normal")

	resp, err := s.client().Do(req)
	if err != nil {
		return Result{Error: err.Error()}
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return Result{OK: true, Status: "ok"}
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
		s.drop(ctx, sub)
		return Result{Error: "webpush: subscription expired"}
	case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusRequestEntityTooLarge:
		return Result{Error: fmt.Sprintf("webpush: status %d", resp.StatusCode)}
	default:
		return Result{Error: fmt.Sprintf("webpush: status %d", resp.StatusCode)}
	}
}

func (s *Service) drop(ctx context.Context, sub Subscription) {
	if sub.ID == "" {
		return
	}
	_ = s.Store.DeletePushSubscription(ctx, sub.ID)
}

// ManageableEndpoint reports why a console-supplied endpoint is not something
// this daemon is willing to post to; nil means it is.
func ManageableEndpoint(endpoint string) error {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return errors.New("endpoint is required")
	}
	u, err := url.Parse(endpoint)
	if err != nil {
		return errors.New("endpoint is not a URL")
	}
	_, err = audienceOf(u.String())
	return err
}
