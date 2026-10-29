package webpush

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/url"
	"strings"
	"time"
)

// vapidLifetime is how long a signed token stays valid. The spec allows up to
// 24 hours; a push service answers 403 to an expired one, and a token that
// outlives the message is a token that outlives a revocation.
const vapidLifetime = 12 * time.Hour

// Keys is the application server's VAPID key pair (RFC 8292). One pair serves
// every subscription of this node; the public half travels to the browser as
// the `applicationServerKey` of the subscription.
type Keys struct {
	private *ecdsa.PrivateKey
}

// GenerateKeys mints a new P-256 pair.
func GenerateKeys() (*Keys, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("webpush: generate keys: %w", err)
	}
	return &Keys{private: priv}, nil
}

// KeysFromPrivate restores a pair from the stored 32-byte scalar, so the
// public key a browser subscribed with keeps matching across restarts.
func KeysFromPrivate(raw []byte) (*Keys, error) {
	if len(raw) != 32 {
		return nil, fmt.Errorf("webpush: private key must be 32 bytes")
	}
	priv, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), raw)
	if err != nil {
		return nil, fmt.Errorf("webpush: parse private key: %w", err)
	}
	return &Keys{private: priv}, nil
}

// PrivateKey is the 32-byte scalar, for storing in settings. Fixed width: a
// scalar with a leading zero byte must still restore, and `D.Bytes()` would
// quietly drop it.
func (k *Keys) PrivateKey() []byte {
	raw := make([]byte, 32)
	k.private.D.FillBytes(raw)
	return raw
}

// PublicKey is the uncompressed 65-byte point, for the browser subscription.
func (k *Keys) PublicKey() []byte {
	pub, err := k.private.ECDH()
	if err != nil {
		// P-256 keys are always convertible; a failure here would be a bug in
		// the standard library rather than in the input.
		panic("webpush: p256 key is not convertible: " + err.Error())
	}
	return pub.PublicKey().Bytes()
}

// PublicKeyBase64 is the form the console hands to `pushManager.subscribe`.
func (k *Keys) PublicKeyBase64() string {
	return base64.RawURLEncoding.EncodeToString(k.PublicKey())
}

// Authorization builds the `vapid t=..., k=...` header value for one endpoint.
//
// The audience is the push service's origin, not ours: a token signed for one
// push service is refused by another, which is what keeps a leaked header from
// being replayed elsewhere.
func (k *Keys) Authorization(endpoint, subject string, now time.Time) (string, error) {
	aud, err := audienceOf(endpoint)
	if err != nil {
		return "", err
	}
	if subject == "" {
		subject = "https://openkin.local"
	}
	header := map[string]string{"typ": "JWT", "alg": "ES256"}
	claims := map[string]any{
		"aud": aud,
		"exp": now.Add(vapidLifetime).Unix(),
		"sub": subject,
	}
	hb, err := json.Marshal(header)
	if err != nil {
		return "", fmt.Errorf("webpush: jwt header: %w", err)
	}
	cb, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("webpush: jwt claims: %w", err)
	}
	signingInput := base64.RawURLEncoding.EncodeToString(hb) + "." +
		base64.RawURLEncoding.EncodeToString(cb)
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, k.private, digest[:])
	if err != nil {
		return "", fmt.Errorf("webpush: sign: %w", err)
	}
	// JWS wants the fixed-width r||s pair, not the ASN.1 structure
	// crypto/ecdsa signs into.
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return "vapid t=" + signingInput + "." + base64.RawURLEncoding.EncodeToString(sig) +
		", k=" + k.PublicKeyBase64(), nil
}

// audienceOf reduces a push endpoint to its origin.
func audienceOf(endpoint string) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("webpush: invalid endpoint")
	}
	if !strings.EqualFold(u.Scheme, "https") {
		return "", fmt.Errorf("webpush: endpoint must be https")
	}
	return u.Scheme + "://" + u.Host, nil
}

// VerifySignature checks a signed JWT against the public key. Tests use it,
// and it is the one place that documents the exact byte layout above.
func (k *Keys) VerifySignature(token string) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(sig) != 64 {
		return false
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:])
	return ecdsa.Verify(&k.private.PublicKey, digest[:], r, s)
}
