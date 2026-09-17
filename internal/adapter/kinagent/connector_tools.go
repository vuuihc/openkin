package kinagent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/vuuihc/openkin/internal/connectors"
	"github.com/vuuihc/openkin/internal/provider"
)

type connectorInvocation struct {
	ConnectorID string
	Tool        string
}

func connectorToolDefinitions(ctx context.Context, host connectors.Host) ([]provider.ToolDef, map[string]connectorInvocation) {
	if host == nil {
		return nil, nil
	}
	var definitions []provider.ToolDef
	invocations := make(map[string]connectorInvocation)
	for _, cfg := range host.List() {
		if cfg.Disabled {
			continue
		}
		tools, err := host.Tools(ctx, cfg.ID)
		if err != nil {
			continue
		}
		for _, tool := range tools {
			name := connectorToolName(cfg.ID, tool.Name)
			if _, exists := invocations[name]; exists {
				continue
			}
			schema, ok := tool.InputSchema.(map[string]any)
			if !ok || schema == nil {
				schema = map[string]any{
					"type":       "object",
					"properties": map[string]any{},
				}
			}
			description := strings.TrimSpace(tool.Description)
			if description == "" {
				description = "Call the allowlisted MCP connector tool."
			}
			definitions = append(definitions, provider.FunctionTool(name,
				fmt.Sprintf("%s (connector %s)", description, cfg.ID), schema))
			invocations[name] = connectorInvocation{ConnectorID: cfg.ID, Tool: tool.Name}
		}
	}
	return definitions, invocations
}

func connectorToolName(connectorID, tool string) string {
	var b strings.Builder
	b.WriteString("connector__")
	for _, value := range connectorID + "__" + tool {
		if (value >= 'a' && value <= 'z') ||
			(value >= 'A' && value <= 'Z') ||
			(value >= '0' && value <= '9') ||
			value == '_' || value == '-' {
			b.WriteRune(value)
			continue
		}
		b.WriteByte('_')
	}
	name := b.String()
	if len(name) <= 64 {
		return name
	}
	sum := sha256.Sum256([]byte(name))
	return name[:48] + "_" + hex.EncodeToString(sum[:])[:15]
}

func (e *toolEnv) runConnectorTool(ctx context.Context, name string, args map[string]any) (string, error) {
	invocation, ok := e.ConnectorTools[name]
	if !ok || e.Connectors == nil {
		return "", fmt.Errorf("unknown connector tool %q", name)
	}
	result, err := e.Connectors.Call(ctx, connectors.Call{
		ConnectorID: invocation.ConnectorID,
		TaskID:      e.TaskID,
		Principal:   "kin",
		Tool:        invocation.Tool,
		Arguments:   args,
	})
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(result.Content)
	if err != nil {
		return "", fmt.Errorf("encode connector result: %w", err)
	}
	if result.IsError {
		return string(data), fmt.Errorf("connector tool returned an error")
	}
	return truncateBytes(string(data), maxToolOutBytes), nil
}
