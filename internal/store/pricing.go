package store

import (
	"encoding/json"
	"fmt"
	"strings"
)

// KeyPriceTable is the settings key for model → per-1M-token USD prices (M4).
const KeyPriceTable = "price_table"

// DefaultPriceTableJSON is a small sensible default for current Codex models.
// Values are USD per 1M input/output tokens (spec §12 example style).
const DefaultPriceTableJSON = `{
  "gpt-5-codex": {"in": 1.25, "out": 10.0},
  "gpt-5.1-codex": {"in": 1.25, "out": 10.0},
  "gpt-5.1-codex-max": {"in": 1.25, "out": 10.0},
  "o3": {"in": 2.0, "out": 8.0},
  "o4-mini": {"in": 1.1, "out": 4.4}
}`

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
		// Hard-coded JSON must always parse.
		panic(err)
	}
	return t
}

// ComputeCost returns USD cost for token counts using the table entry for model.
// ok is false when the model is missing from the table.
func (t PriceTable) ComputeCost(model string, tokensIn, tokensOut int) (cost float64, ok bool) {
	if t == nil {
		return 0, false
	}
	e, found := t[model]
	if !found {
		return 0, false
	}
	cost = float64(tokensIn)/1e6*e.In + float64(tokensOut)/1e6*e.Out
	return cost, true
}
