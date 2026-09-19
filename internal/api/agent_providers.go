package api

import (
	"net/http"

	"github.com/vuuihc/openkin/internal/agent"
)

func (s *Server) handleListAgentProviders(w http.ResponseWriter, r *http.Request) {
	if s.ListAgentProviders != nil {
		list := s.ListAgentProviders()
		if list == nil {
			list = []agent.ProviderInfo{}
		}
		writeJSON(w, http.StatusOK, list)
		return
	}

	// Keep lightweight test servers useful even when the composition root is
	// not installed. The full server supplies evidence-rich rows.
	list := make([]agent.ProviderInfo, 0)
	if s.ListAgents != nil {
		for _, item := range s.ListAgents() {
			state := agent.ProviderNotDetected
			if item.Installed {
				state = agent.ProviderDetected
			}
			if item.Available {
				state = agent.ProviderAvailable
			}
			caps := make([]agent.CapabilityEvidence, 0, len(item.Capabilities))
			for _, name := range item.Capabilities {
				caps = append(caps, agent.CapabilityEvidence{
					Capability: agent.Capability(name),
					State:      state,
				})
			}
			list = append(list, agent.ProviderInfo{
				ID:           item.ID,
				Name:         item.Name,
				Kind:         agent.Kind(item.Kind),
				State:        state,
				Installed:    item.Installed,
				Available:    item.Available,
				Binary:       item.Binary,
				Reason:       item.Reason,
				Capabilities: caps,
			})
		}
	}
	writeJSON(w, http.StatusOK, list)
}
