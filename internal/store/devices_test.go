package store

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/remote"
)

func openDeviceTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestPairingSessionExpiresAndCannotBeReplayed(t *testing.T) {
	s := openDeviceTestStore(t)
	now := time.Now().UnixMilli()
	if err := s.CreatePairingSession(context.Background(), PairingSession{
		SecretHash: remote.HashToken("pairing"),
		CreatedAt:  now, ExpiresAt: now + 100,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ConsumePairingSession(context.Background(), remote.HashToken("pairing"), now+101); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired session error = %v, want ErrNotFound", err)
	}

	if err := s.CreatePairingSession(context.Background(), PairingSession{
		SecretHash: remote.HashToken("usable"),
		CreatedAt:  now, ExpiresAt: now + 1000,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ConsumePairingSession(context.Background(), remote.HashToken("usable"), now+1); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ConsumePairingSession(context.Background(), remote.HashToken("usable"), now+2); !errors.Is(err, ErrNotFound) {
		t.Fatalf("replay error = %v, want ErrNotFound", err)
	}
}

func TestPairingSessionConcurrentConsumeIsSingleUse(t *testing.T) {
	s := openDeviceTestStore(t)
	now := time.Now().UnixMilli()
	if err := s.CreatePairingSession(context.Background(), PairingSession{
		SecretHash: remote.HashToken("concurrent"),
		CreatedAt:  now, ExpiresAt: now + time.Minute.Milliseconds(),
	}); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.ConsumePairingSession(context.Background(), remote.HashToken("concurrent"), now+1)
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	var success, notFound int
	for err := range results {
		switch {
		case err == nil:
			success++
		case errors.Is(err, ErrNotFound):
			notFound++
		default:
			t.Fatalf("consume error = %v", err)
		}
	}
	if success != 1 || notFound != 1 {
		t.Fatalf("success=%d notFound=%d, want one each", success, notFound)
	}
}

func TestPairingSessionInvalidationByLabel(t *testing.T) {
	s := openDeviceTestStore(t)
	now := time.Now().UnixMilli()
	for _, secret := range []string{"old-1", "old-2"} {
		if err := s.CreatePairingSession(context.Background(), PairingSession{
			SecretHash: remote.HashToken(secret),
			Label:      "relay",
			CreatedAt:  now,
			ExpiresAt:  now + time.Minute.Milliseconds(),
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.InvalidatePairingSessions(context.Background(), "relay", now+1); err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"old-1", "old-2"} {
		if _, err := s.ConsumePairingSession(context.Background(), remote.HashToken(secret), now+2); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s invalidation error = %v, want ErrNotFound", secret, err)
		}
	}
}

func TestDeviceCredentialRevocation(t *testing.T) {
	s := openDeviceTestStore(t)
	now := time.Now().UnixMilli()
	tokenHash := remote.HashToken("device-token")
	if err := s.InsertDeviceCredential(context.Background(), DeviceCredential{
		ID: "ios-device", TokenHash: tokenHash, CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AuthenticateDevice(context.Background(), tokenHash, now+1); err != nil {
		t.Fatal(err)
	}
	if err := s.RevokeDeviceCredential(context.Background(), "ios-device", now+2); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AuthenticateDevice(context.Background(), tokenHash, now+3); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoked credential error = %v, want ErrNotFound", err)
	}
}
