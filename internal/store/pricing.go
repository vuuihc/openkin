package store

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
)

// KeyPriceTable is the settings key for model → per-1M-token USD prices (M4).
const KeyPriceTable = "price_table"

// Price table provenance (shown in Settings UI / docs).
const (
	// PriceTableSourceName is the open dataset Kin's defaults are curated from.
	PriceTableSourceName = "LiteLLM"
	// PriceTableSourceURL is the upstream open-source price list.
	PriceTableSourceURL = "https://github.com/BerriAI/litellm"
	// PriceTableSourceFile is the specific JSON file inside that repo.
	PriceTableSourceFile = "model_prices_and_context_window.json"
)

//go:embed default_price_table.json
var defaultPriceTableJSONBytes []byte

// DefaultPriceTableJSON is the built-in default (USD per 1M input/output tokens).
// Curated subset of LiteLLM's open model price list; regenerate via
// scripts/gen_default_price_table.py.
var DefaultPriceTableJSON = string(defaultPriceTableJSONBytes)

// PriceEntry is USD per 1M tokens for one model.
type PriceEntry struct {
	In  float64 `json:"in"`
	Out float64 `json:"out"`
}

// PriceTable maps model name → prices.
type PriceTable map[string]PriceEntry

// ParsePriceTable validates and parses a price_table JSON string.
func ParsePriceTable(raw string) (PriceTable, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("price_table is empty")
	}
	var t PriceTable
	if err := json.Unmarshal([]byte(raw), &t); err != nil {
		return nil, fmt.Errorf("invalid price_table JSON: %w", err)
	}
	if len(t) == 0 {
		return nil, fmt.Errorf("price_table must contain at least one model")
	}
	for name, e := range t {
		if strings.TrimSpace(name) == "" {
			return nil, fmt.Errorf("price_table has empty model name")
		}
		if e.In < 0 || e.Out < 0 {
			return nil, fmt.Errorf("price_table[%q]: in/out must be >= 0", name)
		}
	}
	return t, nil
}

// DefaultPriceTable returns the built-in default table.
func DefaultPriceTable() PriceTable {
	t, err := ParsePriceTable(DefaultPriceTableJSON)
	if err != nil {
		// Embedded JSON must always parse.
		panic(err)
	}
	return t
}

// ComputeCost returns USD cost for token counts using the table entry for model.
// ok is false when the model is missing from the table.
// Lookup is exact first, then a few common alias normalizations.
func (t PriceTable) ComputeCost(model string, tokensIn, tokensOut int) (cost float64, ok bool) {
	if t == nil {
		return 0, false
	}
	e, found := t.lookup(model)
	if !found {
		return 0, false
	}
	cost = float64(tokensIn)/1e6*e.In + float64(tokensOut)/1e6*e.Out
	return cost, true
}

func (t PriceTable) lookup(model string) (PriceEntry, bool) {
	model = strings.TrimSpace(model)
	if model == "" {
		return PriceEntry{}, false
	}
	if e, ok := t[model]; ok {
		return e, true
	}
	// Strip provider prefixes some adapters report (openai/gpt-4o, xai/grok-4.5).
	if i := strings.LastIndex(model, "/"); i >= 0 && i+1 < len(model) {
		if e, ok := t[model[i+1:]]; ok {
			return e, true
		}
	}
	// Case-insensitive fallback.
	lower := strings.ToLower(model)
	for k, e := range t {
		if strings.ToLower(k) == lower {
			return e, true
		}
	}
	if i := strings.LastIndex(lower, "/"); i >= 0 && i+1 < len(lower) {
		bare := lower[i+1:]
		for k, e := range t {
			if strings.ToLower(k) == bare {
				return e, true
			}
		}
	}
	return PriceEntry{}, false
}
