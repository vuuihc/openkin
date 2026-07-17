package provider

// RoleTool is the OpenAI-compatible role for tool results.
const RoleTool = "tool"

// ToolDef is an OpenAI-style function tool definition.
type ToolDef struct {
	Type     string             `json:"type"` // "function"
	Function ToolFunctionSchema `json:"function"`
}

// ToolFunctionSchema describes one callable function.
type ToolFunctionSchema struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters,omitempty"`
}

// ToolCall is one model-requested tool invocation.
type ToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"` // "function"
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"` // JSON string
	} `json:"function"`
}

// FunctionTool builds a function tool def.
func FunctionTool(name, desc string, parameters map[string]any) ToolDef {
	if parameters == nil {
		parameters = map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		}
	}
	return ToolDef{
		Type: "function",
		Function: ToolFunctionSchema{
			Name:        name,
			Description: desc,
			Parameters:  parameters,
		},
	}
}
