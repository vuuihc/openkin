package provider

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"sync"

	"github.com/vuuihc/openkin/internal/secret"
)

var providerSecrets struct {
	sync.RWMutex
	store secret.Store
}

// SetSecretStore enables external provider-key storage for the daemon process.
func SetSecretStore(store secret.Store) {
	providerSecrets.Lock()
	providerSecrets.store = store
	providerSecrets.Unlock()
}

func secretStore() secret.Store {
	providerSecrets.RLock()
	defer providerSecrets.RUnlock()
	return providerSecrets.store
}

func secretReference(id string) string {
	sum := sha256.Sum256([]byte(id))
	return "secret-provider-" + hex.EncodeToString(sum[:16])
}

func isSecretReference(value string) bool {
	return strings.HasPrefix(value, "secret://")
}

func externalizeAPIKey(id, value string) (string, bool, error) {
	value = strings.TrimSpace(value)
	if value == "" || isSecretReference(value) {
		return value, false, nil
	}
	store := secretStore()
	if store == nil {
		return value, false, nil
	}
	ref := secretReference(id)
	if err := store.Put(ref, value); err != nil {
		return "", false, err
	}
	return "secret://" + ref, true, nil
}

func hydrateAPIKey(value string) (string, error) {
	if !isSecretReference(value) {
		return value, nil
	}
	store := secretStore()
	if store == nil {
		return "", errors.New("secret store is not configured")
	}
	return store.Get(strings.TrimPrefix(value, "secret://"))
}
