// Package auth implements the Hub's account model: local password credentials,
// federated OIDC logins, and browser sessions.
//
// Accounts and credentials are separate. An account (`users.id`) is the key
// every other table references; a credential (`user_identities`) is one way to
// reach it, keyed on (provider, subject). Nothing here matches or merges
// accounts by email address, because an OIDC provider may return an address it
// never verified. See docs/plans/2026-10-22-multi-device-session-architecture.md §8.2.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters. These target roughly 100ms on a low-power NAS, which is
// the deployment this is built for; logins are rare enough that the memory cost
// never shows up as sustained load.
const (
	argonMemoryKiB   = 64 * 1024
	argonIterations  = 3
	argonParallelism = 2
	argonSaltLen     = 16
	argonKeyLen      = 32
)

// ErrInvalidCredentials is the single error every failed login returns. It
// deliberately does not distinguish "no such account" from "wrong password" so
// the API cannot be used to enumerate accounts.
var ErrInvalidCredentials = errors.New("auth: invalid credentials")

// ErrInvalidHash means a stored password hash could not be parsed. It is a
// data-integrity error, not a user error.
var ErrInvalidHash = errors.New("auth: malformed password hash")

// HashPassword returns an argon2id hash in PHC string format, so the cost
// parameters travel with the hash and can be raised later without a migration.
func HashPassword(password string) (string, error) {
	if password == "" {
		return "", fmt.Errorf("auth: empty password")
	}
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("auth: generate salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, argonIterations, argonMemoryKiB, argonParallelism, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemoryKiB, argonIterations, argonParallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key)), nil
}

// VerifyPassword reports whether password matches the PHC-encoded hash.
// It returns ErrInvalidCredentials on mismatch and ErrInvalidHash when the
// stored value is unparseable, so a corrupt row is distinguishable from a
// wrong password in logs without leaking that difference to the caller.
func VerifyPassword(encoded, password string) error {
	parts := strings.Split(encoded, "$")
	// ["", "argon2id", "v=19", "m=…,t=…,p=…", salt, key]
	if len(parts) != 6 || parts[1] != "argon2id" {
		return ErrInvalidHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return ErrInvalidHash
	}
	if version != argon2.Version {
		return ErrInvalidHash
	}
	var memory uint32
	var iterations uint32
	var parallelism uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &parallelism); err != nil {
		return ErrInvalidHash
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return ErrInvalidHash
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return ErrInvalidHash
	}
	if len(salt) == 0 || len(want) == 0 {
		return ErrInvalidHash
	}
	got := argon2.IDKey([]byte(password), salt, iterations, memory, parallelism, uint32(len(want)))
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return ErrInvalidCredentials
	}
	return nil
}

// dummyHash is a valid argon2id hash of a random value, generated once at
// startup. Login verifies against it when no credential matched, so a missing
// account costs the same wall-clock time as a wrong password and the response
// time cannot be used to enumerate accounts.
var dummyHash = mustHashRandom()

func mustHashRandom() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		panic("auth: cannot read randomness: " + err.Error())
	}
	h, err := HashPassword(base64.RawStdEncoding.EncodeToString(buf))
	if err != nil {
		panic("auth: cannot hash: " + err.Error())
	}
	return h
}

// burnPasswordTime performs a throwaway verification so failed lookups take the
// same time as failed password checks.
func burnPasswordTime(password string) {
	_ = VerifyPassword(dummyHash, password)
}
