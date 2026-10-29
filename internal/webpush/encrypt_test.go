package webpush

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"testing"
)

// RFC 8291 §5 and Appendix A, verbatim. The vector is the only thing that
// makes a hand-written aes128gcm implementation trustworthy: every value here
// is published, so a mistake in the KDF chain or the header layout shows up as
// a byte difference rather than as silence in a browser.
const (
	rfcPlaintext = "When I grow up, I want to be a watermelon"

	rfcUAPublic  = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
	rfcASPrivate = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"
	rfcAuth      = "BTBZMqHH6r4Tts7J_aSIgg"
	rfcSalt      = "DGv6ra1nlYgDCS1FRnbzlw"

	rfcHeader = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
		"mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
	rfcCiphertext = "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ"
)

func b64(t *testing.T, s string) []byte {
	t.Helper()
	v, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		t.Fatalf("decode %q: %v", s, err)
	}
	return v
}

func TestEncryptMatchesRFC8291Vector(t *testing.T) {
	uaPublic := b64(t, rfcUAPublic)
	authSecret := b64(t, rfcAuth)
	salt := b64(t, rfcSalt)
	sender, err := ecdh.P256().NewPrivateKey(b64(t, rfcASPrivate))
	if err != nil {
		t.Fatalf("sender key: %v", err)
	}

	body, err := encryptWith(salt, sender, uaPublic, authSecret, []byte(rfcPlaintext))
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}

	want := append(b64(t, rfcHeader), b64(t, rfcCiphertext)...)
	if string(body) != string(want) {
		t.Fatalf("body does not match the RFC vector\n got %x\nwant %x", body, want)
	}
}

func TestEncryptHeaderLayout(t *testing.T) {
	uaPublic := b64(t, rfcUAPublic)
	body, err := Encrypt(uaPublic, b64(t, rfcAuth), []byte(`{"title":"x"}`))
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if got := binary.BigEndian.Uint32(body[saltLen:]); got != recordSize {
		t.Fatalf("record size = %d, want %d", got, recordSize)
	}
	if got := body[saltLen+4]; got != 65 {
		t.Fatalf("key id length = %d, want 65", got)
	}
	if got := body[saltLen+5]; got != 0x04 {
		t.Fatalf("key id does not start with the uncompressed point marker: %x", got)
	}
	if len(body) != saltLen+4+1+65+len(`{"title":"x"}`)+1+16 {
		t.Fatalf("body length = %d", len(body))
	}
}

// The body must be openable by a receiver that only holds the subscription's
// private key -- the proof that the ECDH + HKDF chain matches the published
// algorithm in both directions.
func TestEncryptIsDecryptableByTheSubscriptionKey(t *testing.T) {
	ua, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("ua key: %v", err)
	}
	authSecret := make([]byte, 16)
	for i := range authSecret {
		authSecret[i] = byte(i)
	}
	payload := []byte(`{"title":"Approval needed","url":"/inbox?focus=a1"}`)

	body, err := Encrypt(ua.PublicKey().Bytes(), authSecret, payload)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}

	// The receiver's side of RFC 8291 §4.
	salt := body[:saltLen]
	rs := binary.BigEndian.Uint32(body[saltLen:])
	idLen := int(body[saltLen+4])
	asPublic := body[saltLen+5 : saltLen+5+idLen]
	sealed := body[saltLen+5+idLen:]
	if rs != recordSize {
		t.Fatalf("record size = %d", rs)
	}
	as, err := ecdh.P256().NewPublicKey(asPublic)
	if err != nil {
		t.Fatalf("sender key: %v", err)
	}
	shared, err := ua.ECDH(as)
	if err != nil {
		t.Fatalf("ecdh: %v", err)
	}
	prkKey, _ := hkdf.Extract(sha256.New, shared, authSecret)
	ikm, _ := hkdf.Expand(sha256.New, prkKey, "WebPush: info\x00"+string(ua.PublicKey().Bytes())+string(asPublic), 32)
	prk, _ := hkdf.Extract(sha256.New, ikm, salt)
	cek, _ := hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16)
	nonce, _ := hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12)
	block, err := aes.NewCipher(cek)
	if err != nil {
		t.Fatalf("cipher: %v", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("gcm: %v", err)
	}
	plain, err := gcm.Open(nil, nonce, sealed, nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if string(plain) != string(payload)+"\x02" {
		t.Fatalf("plaintext = %q", plain)
	}
}

func TestEncryptRejectsBadInput(t *testing.T) {
	ua, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("ua key: %v", err)
	}
	cases := []struct {
		name      string
		uaPublic  []byte
		auth      []byte
		plaintext []byte
	}{
		{"short key", ua.PublicKey().Bytes()[:32], make([]byte, 16), []byte("x")},
		{"short auth", ua.PublicKey().Bytes(), make([]byte, 15), []byte("x")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Encrypt(tc.uaPublic, tc.auth, tc.plaintext); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}
