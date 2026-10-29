// Package webpush delivers browser push messages: RFC 8291 payload
// encryption, RFC 8292 VAPID authentication, and RFC 8030 delivery.
//
// It exists so a phone can learn that an agent stopped without the reader
// keeping a tab open, and without a third-party app in the loop: the browser's
// own push service carries the message, the same one it already trusts.
package webpush

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"unicode/utf8"
)

const (
	// recordSize is the aes128gcm record size advertised in the header. One
	// record is all a notification needs, and every push service accepts it.
	recordSize = 4096
	saltLen    = 16
	// maxPayload is the largest plaintext one record can carry: the record
	// size minus the 0x02 delimiter and the 16-byte GCM tag.
	//
	// Exceeding it does not produce a longer message, it produces an invalid
	// one: RFC 8188 has one record here, so the receiver parses the tail as a
	// second record header and the push service answers 413 — which the sender
	// treats as retryable, so an oversized routine report would be retried
	// forever and never arrive.
	maxPayload = recordSize - 1 - 16
)

// Encrypt builds the aes128gcm body for one push message (RFC 8291 §4).
//
// uaPublic is the subscription's `p256dh` key and authSecret its `auth`
// secret, both decoded from the base64url the browser handed the console. The
// ephemeral sender key and the salt are fresh per message: the same plaintext
// must never produce the same body twice.
func Encrypt(uaPublic, authSecret, payload []byte) ([]byte, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return nil, fmt.Errorf("webpush: salt: %w", err)
	}
	sender, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("webpush: ephemeral key: %w", err)
	}
	return encryptWith(salt, sender, uaPublic, authSecret, payload)
}

// encryptWith is Encrypt with its randomness supplied, so the RFC's example
// vector can be reproduced exactly.
func encryptWith(salt []byte, sender *ecdh.PrivateKey, uaPublic, authSecret, payload []byte) ([]byte, error) {
	if len(salt) != saltLen {
		return nil, fmt.Errorf("webpush: salt must be %d bytes", saltLen)
	}
	if len(authSecret) != 16 {
		return nil, fmt.Errorf("webpush: auth secret must be 16 bytes")
	}
	ua, err := ecdh.P256().NewPublicKey(uaPublic)
	if err != nil {
		return nil, fmt.Errorf("webpush: subscription key: %w", err)
	}
	shared, err := sender.ECDH(ua)
	if err != nil {
		return nil, fmt.Errorf("webpush: ecdh: %w", err)
	}
	asPublic := sender.PublicKey().Bytes()

	// RFC 8291 §3.3-3.4: the auth secret salts the first extract, and the two
	// public keys are bound into the info so a body cannot be replayed to a
	// different subscription.
	prkKey, err := hkdf.Extract(sha256.New, shared, authSecret)
	if err != nil {
		return nil, fmt.Errorf("webpush: hkdf extract: %w", err)
	}
	keyInfo := "WebPush: info\x00" + string(uaPublic) + string(asPublic)
	ikm, err := hkdf.Expand(sha256.New, prkKey, keyInfo, 32)
	if err != nil {
		return nil, fmt.Errorf("webpush: hkdf expand: %w", err)
	}
	prk, err := hkdf.Extract(sha256.New, ikm, salt)
	if err != nil {
		return nil, fmt.Errorf("webpush: hkdf extract: %w", err)
	}
	cek, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16)
	if err != nil {
		return nil, fmt.Errorf("webpush: cek: %w", err)
	}
	nonce, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12)
	if err != nil {
		return nil, fmt.Errorf("webpush: nonce: %w", err)
	}

	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, fmt.Errorf("webpush: cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("webpush: gcm: %w", err)
	}
	// The last record carries the 0x02 padding delimiter; without it the
	// receiver cannot tell where the payload ends.
	payload = clampPayload(payload)
	record := make([]byte, 0, len(payload)+1)
	record = append(record, payload...)
	record = append(record, 0x02)
	sealed := gcm.Seal(nil, nonce, record, nil)

	header := make([]byte, 0, saltLen+4+1+len(asPublic))
	header = append(header, salt...)
	header = binary.BigEndian.AppendUint32(header, recordSize)
	header = append(header, byte(len(asPublic)))
	header = append(header, asPublic...)
	return append(header, sealed...), nil
}

// clampPayload trims p to one record, on a rune boundary so a truncated body
// does not end in half a character.
func clampPayload(p []byte) []byte {
	if len(p) <= maxPayload {
		return p
	}
	cut := maxPayload
	for cut > 0 && !utf8.RuneStart(p[cut]) {
		cut--
	}
	return p[:cut]
}
