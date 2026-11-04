package api

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
)

// oidcFakeIdP signs real ID tokens, so the API tests drive discovery, code
// exchange, signature verification, and nonce checking through the real HTTP
// callback path rather than stubbing Complete.
type oidcFakeIdP struct {
	server   *httptest.Server
	key      *rsa.PrivateKey
	keyID    string
	clientID string
	claims   map[string]any
	nonce    string
}

// newOIDCFakeIdP starts the fake provider. Claims merge into every ID token
// its token endpoint mints; the nonce is per-flow and set by complete.
func newOIDCFakeIdP(t *testing.T, clientID string) *oidcFakeIdP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	idp := &oidcFakeIdP{key: key, keyID: "test-key", clientID: clientID}

	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		writeFakeJSON(w, map[string]any{
			"issuer":                                idp.server.URL,
			"authorization_endpoint":                idp.server.URL + "/auth",
			"token_endpoint":                        idp.server.URL + "/token",
			"jwks_uri":                              idp.server.URL + "/jwks",
			"id_token_signing_alg_values_supported": []string{"RS256"},
			"response_types_supported":              []string{"code"},
			"subject_types_supported":               []string{"public"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		writeFakeJSON(w, map[string]any{"keys": []any{map[string]any{
			"kty": "RSA", "kid": idp.keyID, "use": "sig", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		}}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		claims := map[string]any{
			"iss": idp.server.URL,
			"sub": "subject-1",
			"aud": idp.clientID,
			"exp": time.Now().Add(time.Hour).Unix(),
			"iat": time.Now().Unix(),
		}
		if idp.nonce != "" {
			claims["nonce"] = idp.nonce
		}
		for k, v := range idp.claims {
			claims[k] = v
		}
		writeFakeJSON(w, map[string]any{
			"access_token": "access-token", "token_type": "Bearer",
			"id_token": idp.sign(t, claims), "expires_in": 3600,
		})
	})

	idp.server = httptest.NewServer(mux)
	t.Cleanup(idp.server.Close)
	return idp
}

// Issuer is the fake provider's issuer URL.
func (f *oidcFakeIdP) Issuer() string { return f.server.URL }

// SetClaims merges claims into every ID token the token endpoint mints.
func (f *oidcFakeIdP) SetClaims(claims map[string]any) { f.claims = claims }

// complete derives the nonce from the authorization URL Kin produced — the hop
// a browser would perform — and returns the state and code the callback gets.
func (f *oidcFakeIdP) complete(t *testing.T, authURL string) (state, code string) {
	t.Helper()
	u, err := url.Parse(authURL)
	if err != nil {
		t.Fatalf("parse auth url: %v", err)
	}
	f.nonce = u.Query().Get("nonce")
	if f.nonce == "" {
		t.Fatal("authorization URL carries no nonce")
	}
	return u.Query().Get("state"), "auth-code"
}

func (f *oidcFakeIdP) sign(t *testing.T, claims map[string]any) string {
	t.Helper()
	signer, err := jose.NewSigner(
		jose.SigningKey{Algorithm: jose.RS256, Key: jose.JSONWebKey{Key: f.key, KeyID: f.keyID}},
		(&jose.SignerOptions{}).WithType("JWT"),
	)
	if err != nil {
		t.Fatalf("new signer: %v", err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	obj, err := signer.Sign(payload)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	serialized, err := obj.CompactSerialize()
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	return serialized
}

func writeFakeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
