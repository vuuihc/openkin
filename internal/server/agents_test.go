package server

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/vuuihc/openkin/internal/agent"
)

type providerCatalogStub struct {
	err error
}

func (c providerCatalogStub) List(context.Context, agent.SessionQuery) ([]agent.SessionInfo, error) {
	return nil, c.err
}

func (c providerCatalogStub) Inspect(context.Context, string) (agent.SessionInfo, error) {
	return agent.SessionInfo{}, c.err
}

func (c providerCatalogStub) ReadHistory(context.Context, string, agent.HistoryQuery) (agent.HistoryPage, error) {
	return agent.HistoryPage{}, c.err
}

func TestSessionCatalogStateRequiresHealthySource(t *testing.T) {
	tests := []struct {
		name string
		cat  agent.SessionCatalog
		want agent.ProviderState
	}{
		{name: "missing", want: agent.ProviderUnsupported},
		{name: "healthy", cat: providerCatalogStub{}, want: agent.ProviderAvailable},
		{name: "degraded", cat: providerCatalogStub{err: errors.New("root missing")}, want: agent.ProviderDegraded},
		{name: "permission", cat: providerCatalogStub{err: os.ErrPermission}, want: agent.ProviderPermissionRequired},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, _ := sessionCatalogState(tt.cat)
			if got != tt.want {
				t.Fatalf("state=%q want %q", got, tt.want)
			}
		})
	}
}
