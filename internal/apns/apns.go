// Package apns delivers native alerts to iPhone installations through Apple's
// Push Notification service.
//
// It is deliberately small: the daemon owns the credentials, the device
// registry, and the decision to notify; this package only turns one event into
// one HTTP/2 request and reports what Apple said. Provider tokens are cached
// and re-minted on a timer, because Apple rejects tokens older than an hour and
// a daemon that re-signs per notification would waste an ECDSA signature on
// every message.
package apns

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Settings keys for the node's APNs credentials. They are written by the
// operator CLI and never returned by the settings API.
const (
	KeyKeyID       = "push.apns.key_id"
	KeyTeamID      = "push.apns.team_id"
	KeyPrivateKey  = "push.apns.private_key"
	KeyTopic       = "push.apns.topic"
	KeyEnvironment = "push.apns.environment"
)

// Environment selects Apple's production or sandbox host. A token minted by a
// development build only works against sandbox, and vice versa, so the device
// row carries the environment it registered from.
type Environment string

const (
	Production Environment = "production"
	Sandbox    Environment = "sandbox"
)

// Notification is the alert one event becomes.
type Notification struct {
	Title string
	Body  string
	// URL is the console link opened when the notification is tapped: an
	// absolute link on the node's ui.base_url, or a path when no base is set.
	// The shell validates it before navigating.
	URL string
	// Kind and ID let the client dedupe and route without parsing the text.
	Kind string
	ID   string
	// ThreadID groups notifications that concern the same conversation.
	ThreadID string
	// CollapseID is the banner identity: a later event with the same value
	// replaces the earlier banner instead of stacking. It is separate from
	// ThreadID because two approvals in one conversation belong to the same
	// group but are two different things to act on.
	CollapseID string
}

// Config is the node's APNs identity.
type Config struct {
	KeyID       string
	TeamID      string
	Topic       string
	Environment Environment
	PrivateKey  *ecdsa.PrivateKey
	// BaseURL overrides the Apple host in tests.
	BaseURL string
}

// Result is what Apple answered, or what the transport failed to ask.
type Result struct {
	OK     bool
	Status int
	APNSID string
	Reason string
	// Expired marks a token Apple will never accept again (410, Unregistered,
	// BadDeviceToken), so the caller can delete the device row.
	Expired bool
}

// ErrNotConfigured is returned when the node has no usable credentials.
var ErrNotConfigured = errors.New("apns: credentials are not configured")

// SettingsReader loads the node's APNs settings.
type SettingsReader interface {
	GetSetting(ctx context.Context, key string) (string, error)
}

// FromSettings builds a client from the node's settings. ErrNotConfigured means
// the operator has not set one up yet, which is a normal state, not a fault.
func FromSettings(ctx context.Context, r SettingsReader) (*Client, error) {
	get := func(key string) string {
		v, err := r.GetSetting(ctx, key)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(v)
	}
	keyID, teamID, topic := get(KeyKeyID), get(KeyTeamID), get(KeyTopic)
	keyPEM := get(KeyPrivateKey)
	env := Environment(get(KeyEnvironment))
	if env == "" {
		env = Production
	}
	if keyID == "" || teamID == "" || topic == "" || keyPEM == "" {
		return nil, ErrNotConfigured
	}
	key, err := ParsePrivateKey([]byte(keyPEM))
	if err != nil {
		return nil, err
	}
	return New(Config{KeyID: keyID, TeamID: teamID, Topic: topic, Environment: env, PrivateKey: key})
}

// Status reports the non-secret half of the APNs identity for a passive view:
// the topic and environment, and whether the identity is complete. It never
// reads or parses the private key. A malformed key is a send-time error, not a
// reason for `kin notify apns --status` to touch the secret.
func Status(ctx context.Context, r SettingsReader) (topic string, env Environment, ok bool) {
	get := func(key string) string {
		v, err := r.GetSetting(ctx, key)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(v)
	}
	topic = get(KeyTopic)
	env = Environment(get(KeyEnvironment))
	if env == "" {
		env = Production
	}
	return topic, env, get(KeyKeyID) != "" && get(KeyTeamID) != "" && topic != ""
}

// ConfiguredInSettings reports whether the node has the non-secret metadata of
// an APNs identity. A passive settings view uses this: it must not read or
// parse the private key just to say "configured". The key is read only for an
// explicit send, where a parse failure can be reported to the person asking.
func ConfiguredInSettings(ctx context.Context, r SettingsReader) bool {
	_, _, ok := Status(ctx, r)
	return ok
}

// Client sends notifications for one APNs identity.
type Client struct {
	cfg  Config
	http *http.Client
	now  func() time.Time

	mu        sync.Mutex
	token     string
	tokenAt   time.Time
	tokenLife time.Duration
}

// New validates cfg and returns a client.
func New(cfg Config) (*Client, error) {
	cfg.KeyID = strings.TrimSpace(cfg.KeyID)
	cfg.TeamID = strings.TrimSpace(cfg.TeamID)
	cfg.Topic = strings.TrimSpace(cfg.Topic)
	if cfg.Environment == "" {
		cfg.Environment = Production
	}
	if cfg.Environment != Production && cfg.Environment != Sandbox {
		return nil, fmt.Errorf("apns: unknown environment %q", cfg.Environment)
	}
	if cfg.KeyID == "" || cfg.TeamID == "" || cfg.Topic == "" || cfg.PrivateKey == nil {
		return nil, ErrNotConfigured
	}
	return &Client{
		cfg:       cfg,
		http:      &http.Client{Timeout: 10 * time.Second},
		now:       time.Now,
		tokenLife: 50 * time.Minute,
	}, nil
}

// Configured reports whether the node can send at all.
func (c *Client) Configured() bool { return c != nil && c.cfg.PrivateKey != nil }

// Topic returns the bundle id notifications are sent to.
func (c *Client) Topic() string {
	if c == nil {
		return ""
	}
	return c.cfg.Topic
}

// Environment returns the environment the node was configured with.
func (c *Client) Environment() Environment {
	if c == nil {
		return ""
	}
	return c.cfg.Environment
}

// ParsePrivateKey reads an Apple .p8 signing key (PKCS#8, EC P-256).
func ParsePrivateKey(pemBytes []byte) (*ecdsa.PrivateKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("apns: private key is not PEM")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("apns: parse private key: %w", err)
	}
	ec, ok := key.(*ecdsa.PrivateKey)
	if !ok || ec.Curve.Params().Name != "P-256" {
		return nil, errors.New("apns: private key must be an EC P-256 key")
	}
	return ec, nil
}

// Send delivers one notification to one device token.
func (c *Client) Send(ctx context.Context, token string, env Environment, n Notification) Result {
	if !c.Configured() {
		return Result{Reason: ErrNotConfigured.Error()}
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return Result{Reason: "empty device token"}
	}
	if env == "" {
		env = c.cfg.Environment
	}
	jwt, err := c.providerToken()
	if err != nil {
		return Result{Reason: err.Error()}
	}
	body, err := json.Marshal(payload(n))
	if err != nil {
		return Result{Reason: err.Error()}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint(env, token), bytes.NewReader(body))
	if err != nil {
		return Result{Reason: transportReason(err)}
	}
	req.Header.Set("authorization", "bearer "+jwt)
	req.Header.Set("apns-topic", c.cfg.Topic)
	req.Header.Set("apns-push-type", "alert")
	req.Header.Set("apns-priority", "10")
	req.Header.Set("content-type", "application/json")
	// A later event about the same target replaces the earlier banner instead
	// of stacking a second one. Apple caps this header at 64 bytes. Callers
	// that do not name a distinct target fall back to the group id, which is
	// what every notification did before the two were separated.
	id := n.CollapseID
	if id == "" {
		id = n.ThreadID
	}
	if id = collapseID(id); id != "" {
		req.Header.Set("apns-collapse-id", id)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return Result{Reason: transportReason(err)}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	out := Result{Status: resp.StatusCode, APNSID: resp.Header.Get("apns-id")}
	if resp.StatusCode == http.StatusOK {
		out.OK = true
		return out
	}
	out.Reason = providerReason(raw)
	if out.Reason == "" {
		out.Reason = fmt.Sprintf("status %d", resp.StatusCode)
	}
	out.Expired = resp.StatusCode == http.StatusGone ||
		out.Reason == "Unregistered" || out.Reason == "BadDeviceToken" || out.Reason == "DeviceTokenNotForTopic"
	return out
}

// endpoint returns the host for the device's environment, not the node's: a
// sandbox token sent to production is rejected as BadDeviceToken.
func (c *Client) endpoint(env Environment, token string) string {
	base := strings.TrimRight(c.cfg.BaseURL, "/")
	if base == "" {
		if env == Sandbox {
			base = "https://api.sandbox.push.apple.com"
		} else {
			base = "https://api.push.apple.com"
		}
	}
	return base + "/3/device/" + token
}

// providerToken mints and caches the ES256 JWT Apple expects.
func (c *Client) providerToken() (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if c.token != "" && now.Sub(c.tokenAt) < c.tokenLife {
		return c.token, nil
	}
	token, err := signProviderToken(c.cfg, now)
	if err != nil {
		return "", err
	}
	c.token = token
	c.tokenAt = now
	return token, nil
}

func signProviderToken(cfg Config, now time.Time) (string, error) {
	header, _ := json.Marshal(map[string]string{"alg": "ES256", "kid": cfg.KeyID})
	claims, _ := json.Marshal(map[string]any{"iss": cfg.TeamID, "iat": now.Unix()})
	signing := b64(header) + "." + b64(claims)
	digest := sha256.Sum256([]byte(signing))
	r, s, err := ecdsa.Sign(rand.Reader, cfg.PrivateKey, digest[:])
	if err != nil {
		return "", fmt.Errorf("apns: sign provider token: %w", err)
	}
	// JWT ES256 signatures are the raw 32-byte r || s pair, not ASN.1.
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return signing + "." + b64(sig), nil
}

// collapseID keeps a grouping id inside Apple's 64-byte header limit. Callers
// pass opaque ids (approval, task, worker, routine), which are ASCII.
func collapseID(id string) string {
	if len(id) > 64 {
		return id[:64]
	}
	return id
}

func payload(n Notification) map[string]any {
	aps := map[string]any{
		"alert": map[string]string{"title": n.Title, "body": n.Body},
		"sound": "default",
	}
	if n.ThreadID != "" {
		aps["thread-id"] = n.ThreadID
	}
	return map[string]any{
		"aps": aps,
		"kin": map[string]string{
			"kind": n.Kind,
			"id":   n.ID,
			"url":  n.URL,
		},
	}
}

// transportReason keeps what an operator can act on from a request failure
// without the request URL, which carries the device token. net/http wraps
// failures in *url.Error and formats them as
// `POST "https://…/3/device/<token>": <cause>`; the cause is the useful part,
// and the token must never reach a log, the device row, or the settings page.
func transportReason(err error) string {
	var urlErr *url.Error
	if errors.As(err, &urlErr) && urlErr.Err != nil {
		return strings.TrimSpace(urlErr.Err.Error())
	}
	if err == nil {
		return ""
	}
	return "request failed"
}

func providerReason(body []byte) string {
	var out struct {
		Reason string `json:"reason"`
	}
	if json.Unmarshal(body, &out) != nil {
		return ""
	}
	return out.Reason
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }
