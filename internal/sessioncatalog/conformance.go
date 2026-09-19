package sessioncatalog

import (
	"context"
	"fmt"
	"strings"

	"github.com/vuuihc/openkin/internal/agent"
)

// CheckConformance exercises the metadata-only contract every file-backed
// provider catalog must satisfy. It deliberately checks bounded reads and
// namespaced references, not provider-specific transcript details.
func CheckConformance(ctx context.Context, catalog agent.SessionCatalog, externalRef string) error {
	if catalog == nil {
		return fmt.Errorf("catalog is nil")
	}
	externalRef = strings.TrimSpace(externalRef)
	if externalRef == "" {
		return fmt.Errorf("external reference is required")
	}
	rows, err := catalog.List(ctx, agent.SessionQuery{Limit: 500, Query: externalRef})
	if err != nil {
		return fmt.Errorf("list: %w", err)
	}
	found := false
	for _, row := range rows {
		if row.ExternalRef == externalRef {
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("list did not return %q", externalRef)
	}
	info, err := catalog.Inspect(ctx, externalRef)
	if err != nil {
		return fmt.Errorf("inspect: %w", err)
	}
	if info.AgentID == "" || info.ExternalRef != externalRef || info.SourceURI == "" {
		return fmt.Errorf("inspect returned incomplete metadata: %+v", info)
	}
	page, err := catalog.ReadHistory(ctx, externalRef, agent.HistoryQuery{Limit: 100})
	if err != nil {
		return fmt.Errorf("read history: %w", err)
	}
	if len(page.Items) > 100 {
		return fmt.Errorf("history returned %d items for limit 100", len(page.Items))
	}
	for _, item := range page.Items {
		if item.AgentID != info.AgentID || item.ExternalRef != externalRef {
			return fmt.Errorf("history item is not namespaced: %+v", item)
		}
		if len([]rune(item.Text)) > 64<<10 {
			return fmt.Errorf("history item exceeds bounded text: %d runes", len([]rune(item.Text)))
		}
	}
	return nil
}
