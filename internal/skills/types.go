// Package skills implements the file-backed Skill runtime.
package skills

import "time"

// Scope controls precedence when the same Skill name exists in several roots.
type Scope string

const (
	ScopeBundled Scope = "bundled"
	ScopeUser    Scope = "user"
	ScopeProject Scope = "project"
)

// Manifest is the validated metadata and instructions for one Skill package.
type Manifest struct {
	Name            string    `json:"name"`
	Version         string    `json:"version"`
	Description     string    `json:"description,omitempty"`
	SupportedAgents []string  `json:"supported_agents,omitempty"`
	Permissions     []string  `json:"permissions,omitempty"`
	NetworkDomains  []string  `json:"network_domains,omitempty"`
	Instructions    string    `json:"instructions"`
	Root            string    `json:"root"`
	Scope           Scope     `json:"scope"`
	Source          string    `json:"source"`
	LoadedAt        time.Time `json:"loaded_at"`
}

// Reference identifies the exact Skill versions that influenced a task.
type Reference struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Scope   Scope  `json:"scope"`
	Source  string `json:"source"`
}

// Context is the prompt material and audit references selected for a task.
type Context struct {
	Instructions string      `json:"instructions,omitempty"`
	References   []Reference `json:"references,omitempty"`
}

// Config defines the three local Skill roots. Empty roots are ignored.
type Config struct {
	BundledDir string
	UserDir    string
	ProjectDir string
}

// ImportRequest describes an explicit Skill import source.
type ImportRequest struct {
	Source string
	Dest   string
}
