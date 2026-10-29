package store

import (
	"context"
	"path/filepath"
	"testing"
)

// A push registration is one browser's endpoint and the keys its push service
// expects. What is pinned here is the identity rule: one row per endpoint, so a
// browser that subscribes twice is not notified twice.

func openPushStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestPushSubscriptionRoundTrip(t *testing.T) {
	s := openPushStore(t)
	ctx := context.Background()
	if err := s.SavePushSubscription(ctx, PushSubscription{
		ID: "p1", Endpoint: "https://push.example.net/a", P256DH: "key-a", Auth: "auth-a", CreatedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	subs, err := s.ListPushSubscriptions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 || subs[0].ID != "p1" || subs[0].P256DH != "key-a" {
		t.Fatalf("subs = %+v", subs)
	}
	if n, err := s.CountPushSubscriptions(ctx); err != nil || n != 1 {
		t.Fatalf("count = %d, %v", n, err)
	}
}

func TestPushSubscriptionIsUniquePerEndpoint(t *testing.T) {
	s := openPushStore(t)
	ctx := context.Background()
	if err := s.SavePushSubscription(ctx, PushSubscription{
		ID: "p1", Endpoint: "https://push.example.net/a", P256DH: "key-a", Auth: "auth-a", CreatedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	// The same browser subscribing again after a key rotation.
	if err := s.SavePushSubscription(ctx, PushSubscription{
		ID: "p2", Endpoint: "https://push.example.net/a", P256DH: "key-b", Auth: "auth-b", CreatedAt: 2000,
	}); err != nil {
		t.Fatal(err)
	}
	subs, err := s.ListPushSubscriptions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 {
		t.Fatalf("one endpoint produced %d rows", len(subs))
	}
	if subs[0].P256DH != "key-b" || subs[0].Auth != "auth-b" || subs[0].ID != "p1" {
		t.Fatalf("row was not updated in place: %+v", subs[0])
	}
	if n, _ := s.CountPushSubscriptions(ctx); n != 1 {
		t.Fatalf("count = %d", n)
	}
}

func TestPushSubscriptionDelete(t *testing.T) {
	s := openPushStore(t)
	ctx := context.Background()
	for _, sub := range []PushSubscription{
		{ID: "p1", Endpoint: "https://push.example.net/a", P256DH: "k", Auth: "a", CreatedAt: 1000},
		{ID: "p2", Endpoint: "https://push.example.net/b", P256DH: "k", Auth: "a", CreatedAt: 2000},
	} {
		if err := s.SavePushSubscription(ctx, sub); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.DeletePushSubscription(ctx, "p1"); err != nil {
		t.Fatal(err)
	}
	subs, _ := s.ListPushSubscriptions(ctx)
	if len(subs) != 1 || subs[0].ID != "p2" {
		t.Fatalf("subs after delete = %+v", subs)
	}
	// Unsubscribing from the console knows only the endpoint.
	if err := s.DeletePushSubscriptionByEndpoint(ctx, "https://push.example.net/b"); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.CountPushSubscriptions(ctx); n != 0 {
		t.Fatalf("count = %d", n)
	}
}

func TestPushSubscriptionRequiresEveryField(t *testing.T) {
	s := openPushStore(t)
	ctx := context.Background()
	cases := []PushSubscription{
		{Endpoint: "https://push.example.net/a", P256DH: "k", Auth: "a", CreatedAt: 1000},
		{ID: "p1", P256DH: "k", Auth: "a", CreatedAt: 1000},
		{ID: "p1", Endpoint: "https://push.example.net/a", Auth: "a", CreatedAt: 1000},
		{ID: "p1", Endpoint: "https://push.example.net/a", P256DH: "k", CreatedAt: 1000},
		{ID: "p1", Endpoint: "https://push.example.net/a", P256DH: "k", Auth: "a"},
	}
	for i, sub := range cases {
		if err := s.SavePushSubscription(ctx, sub); err == nil {
			t.Errorf("case %d: expected an error", i)
		}
	}
}
