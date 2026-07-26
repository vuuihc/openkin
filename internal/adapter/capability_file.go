// Package adapter provides the agent-process interface and workspace capability
// file management for execution identity scoping.
package adapter

import (
	"fmt"
	"os"
	"path/filepath"
)

// EnvKinExecutionToken is the environment variable name for the execution capability token.
const EnvKinExecutionToken = "KIN_EXECUTION_TOKEN"

// WriteCapabilityFile writes a capability token to a file under the task's
// execution directory so the adapter process can read it for MCP bridge auth.
// Returns the absolute path to the file.
func WriteCapabilityFile(execDir, token string) (string, error) {
	if execDir == "" {
		return "", fmt.Errorf("adapter: exec dir is required")
	}
	if token == "" {
		return "", fmt.Errorf("adapter: token is required")
	}

	if err := os.MkdirAll(execDir, 0o700); err != nil {
		return "", fmt.Errorf("adapter: create exec dir: %w", err)
	}

	path := filepath.Join(execDir, ".kin_execution_token")
	if err := os.WriteFile(path, []byte(token), 0o600); err != nil {
		return "", fmt.Errorf("adapter: write capability file: %w", err)
	}
	return path, nil
}

// RemoveCapabilityFile removes the capability file at the given path.
// Errors are silently ignored (the file may already be deleted).
func RemoveCapabilityFile(path string) {
	_ = os.Remove(path)
}

// CapabilityFileEnv returns the KIN_EXECUTION_TOKEN env entry for the adapter.
func CapabilityFileEnv(capabilityPath string) map[string]string {
	if capabilityPath == "" {
		return nil
	}
	return map[string]string{
		EnvKinExecutionToken: capabilityPath,
	}
}
