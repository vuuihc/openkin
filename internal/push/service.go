// Package push wires browser push registrations to the notification fan-out.
//
// The transport lives in internal/webpush: this package owns the two things
// that make it a product feature — where the VAPID key pair is kept, and how a
// notification becomes one message per subscribed browser.
package push

import (
	"context"
	"crypto/ecdh"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/vuuihc/openkin/internal/notify"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/webpush"
)

// KeyVAPIDPrivate is the settings row holding the node's VAPID private key.
//
// It is a setting rather than a column because it is one value for the whole
// node and it must survive a schema rebuild. It is deliberately not in the
// settings API's puttable set: a client that could write it could sign
// notifications the browsers did not subscribe to.
const KeyVAPIDPrivate = "push.vapid_private"

// Service sends notifications to every registered browser.
type Service struct {
	Store *store.Store
	// Subject is the VAPID contact: an https origin or mailto address. A push
	// service may use it to reach the operator about a misbehaving sender.
	Subject string
	Client  *http.Client
	Now     func() time.Time

	mu   sync.Mutex
	keys *webpush.Keys
}

// PublicKey returns the key browsers subscribe with, minting the pair on first
// use.
//
// Lazy rather than at startup: a daemon whose owner never enables
// notifications carries no unused key material, and the pair exists by the
// time the console asks for it.
func (s *Service) PublicKey(ctx context.Context) (string, error) {
	keys, err := s.vapidKeys(ctx)
	if err != nil {
		return "", err
	}
	return keys.PublicKeyBase64(), nil
}

// Count reports how many browsers would receive a message.
func (s *Service) Count(ctx context.Context) (int, error) {
	return s.Store.CountPushSubscriptions(ctx)
}

func (s *Service) vapidKeys(ctx context.Context) (*webpush.Keys, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.keys != nil {
		return s.keys, nil
	}
	stored, err := s.Store.GetSetting(ctx, KeyVAPIDPrivate)
	switch {
	case err == nil && stored != "":
		raw, decErr := base64.RawURLEncoding.DecodeString(stored)
		if decErr != nil {
			return nil, fmt.Errorf("push: stored vapid key: %w", decErr)
		}
		keys, keyErr := webpush.KeysFromPrivate(raw)
		if keyErr != nil {
			return nil, keyErr
		}
		s.keys = keys
		return keys, nil
	case err != nil && !errors.Is(err, store.ErrNotFound):
		return nil, fmt.Errorf("push: read vapid key: %w", err)
	}
	keys, err := webpush.GenerateKeys()
	if err != nil {
		return nil, err
	}
	if err := s.Store.SetSetting(ctx, KeyVAPIDPrivate, base64.RawURLEncoding.EncodeToString(keys.PrivateKey())); err != nil {
		return nil, fmt.Errorf("push: store vapid key: %w", err)
	}
	s.keys = keys
	return keys, nil
}

// Push delivers one notification to every registered browser. It implements
// notify.Pusher.
func (s *Service) Push(ctx context.Context, p notify.Payload) []notify.ChannelResult {
	if s == nil || s.Store == nil {
		return nil
	}
	keys, err := s.vapidKeys(ctx)
	if err != nil {
		return []notify.ChannelResult{{Channel: "push", Error: err.Error()}}
	}
	svc := &webpush.Service{
		Store:   storeAdapter{s.Store},
		Keys:    keys,
		Subject: s.Subject,
		Client:  s.Client,
		Now:     s.Now,
	}
	results := svc.Send(ctx, webpush.Payload{Title: p.Title, Body: p.Body, URL: p.URL})
	if len(results) == 0 {
		// No subscriptions: the channel is simply not configured, and an empty
		// result would read as a channel that failed.
		return nil
	}
	out := make([]notify.ChannelResult, 0, len(results))
	for _, r := range results {
		out = append(out, notify.ChannelResult{
			Channel: "push",
			OK:      r.OK,
			Status:  r.Status,
			Error:   r.Error,
		})
	}
	return out
}

// storeAdapter keeps the transport's row type at the boundary.
type storeAdapter struct{ s *store.Store }

func (a storeAdapter) ListPushSubscriptions(ctx context.Context) ([]webpush.Subscription, error) {
	subs, err := a.s.ListPushSubscriptions(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]webpush.Subscription, 0, len(subs))
	for _, sub := range subs {
		out = append(out, webpush.Subscription{
			ID: sub.ID, Endpoint: sub.Endpoint, P256DH: sub.P256DH, Auth: sub.Auth,
		})
	}
	return out, nil
}

func (a storeAdapter) DeletePushSubscription(ctx context.Context, id string) error {
	return a.s.DeletePushSubscription(ctx, id)
}

// ValidateRegistration checks a console-supplied subscription before it is
// stored.
//
// The alternative is discovering a bad endpoint or an unusable key on the
// first real notification — inside a fire-and-forget goroutine, where nobody
// is looking. A registration that cannot work is refused while the reader is
// still on the settings page.
func ValidateRegistration(endpoint, p256dh, auth string) error {
	if err := webpush.ManageableEndpoint(endpoint); err != nil {
		return err
	}
	key, err := base64.RawURLEncoding.DecodeString(p256dh)
	if err != nil {
		return errors.New("p256dh is not base64url")
	}
	if _, err := ecdh.P256().NewPublicKey(key); err != nil {
		return errors.New("p256dh is not a P-256 public key")
	}
	secret, err := base64.RawURLEncoding.DecodeString(auth)
	if err != nil {
		return errors.New("auth is not base64url")
	}
	if len(secret) != 16 {
		return errors.New("auth must be 16 bytes")
	}
	return nil
}
