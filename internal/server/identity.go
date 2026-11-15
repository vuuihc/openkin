package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
)

const (
	desktopIDSettingKey   = "desktop.id"
	desktopNameSettingKey = "desktop.name"
)

type desktopIdentity struct {
	ID   string
	Name string
}

func ensureDesktopIdentity(ctx context.Context, st *store.Store) (desktopIdentity, error) {
	id, err := st.GetSetting(ctx, desktopIDSettingKey)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return desktopIdentity{}, fmt.Errorf("load desktop id: %w", err)
	}
	name, nameErr := st.GetSetting(ctx, desktopNameSettingKey)
	if nameErr != nil && !errors.Is(nameErr, store.ErrNotFound) {
		return desktopIdentity{}, fmt.Errorf("load desktop name: %w", nameErr)
	}

	values := map[string]string{}
	id = strings.TrimSpace(id)
	if id == "" {
		secret, err := remote.NewSecret()
		if err != nil {
			return desktopIdentity{}, fmt.Errorf("generate desktop id: %w", err)
		}
		id = "desktop_" + secret[:16]
		values[desktopIDSettingKey] = id
	}

	name = strings.TrimSpace(name)
	if name == "" {
		name = defaultDesktopName()
		values[desktopNameSettingKey] = name
	}

	if err := st.SetSettings(ctx, values); err != nil {
		return desktopIdentity{}, fmt.Errorf("persist desktop identity: %w", err)
	}
	return desktopIdentity{ID: id, Name: name}, nil
}

func defaultDesktopName() string {
	if hostname, err := os.Hostname(); err == nil {
		if trimmed := strings.TrimSpace(hostname); trimmed != "" {
			return trimmed
		}
	}
	return "Kin Desktop"
}
