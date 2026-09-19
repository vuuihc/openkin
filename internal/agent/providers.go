package agent

import "time"

// ProviderState describes the observed state of a local Agent integration.
// It is intentionally separate from runnable/installed booleans: a detected
// binary does not imply that session APIs are available.
type ProviderState string

const (
	ProviderNotDetected        ProviderState = "not_detected"
	ProviderDetected           ProviderState = "detected"
	ProviderAvailable          ProviderState = "available"
	ProviderUnsupported        ProviderState = "unsupported"
	ProviderDegraded           ProviderState = "degraded"
	ProviderPermissionRequired ProviderState = "permission_required"
)

// CapabilityEvidence records an observed capability and the evidence behind it.
type CapabilityEvidence struct {
	Capability Capability    `json:"capability"`
	State      ProviderState `json:"state"`
	Evidence   string        `json:"evidence,omitempty"`
}

// ProviderInfo is the provider-management view shared by API and UI.
type ProviderInfo struct {
	ID            string               `json:"id"`
	Name          string               `json:"name"`
	Kind          Kind                 `json:"kind"`
	State         ProviderState        `json:"state"`
	Installed     bool                 `json:"installed"`
	Available     bool                 `json:"available"`
	Binary        string               `json:"binary,omitempty"`
	Source        string               `json:"source,omitempty"`
	Reason        string               `json:"reason,omitempty"`
	Evidence      []string             `json:"evidence,omitempty"`
	Capabilities  []CapabilityEvidence `json:"capabilities,omitempty"`
	LastScannedAt time.Time            `json:"last_scanned_at"`
}
