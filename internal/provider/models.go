package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

// modelsListTimeout bounds the /models discovery call; overridable in tests.
var modelsListTimeout = 20 * time.Second

// oaiModelsResp is the OpenAI-compatible GET /models response shape.
type oaiModelsResp struct {
	Data []struct {
		ID string `json:"id"`
	} `json:"data"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// ListModels queries the provider's model-listing endpoint and returns the
// available model ids, sorted. Only openai-compatible providers are
// supported (GET {base_url}/models); other kinds return an error.
func ListModels(ctx context.Context, cfg Config) ([]string, error) {
	cfg = cfg.Normalize()
	if cfg.BaseURL == "" {
		return nil, fmt.Errorf("provider.base_url is required")
	}
	if !strings.HasPrefix(cfg.BaseURL, "http://") && !strings.HasPrefix(cfg.BaseURL, "https://") {
		return nil, fmt.Errorf("provider.base_url must be http(s)")
	}
	if cfg.Kind != "" && cfg.Kind != "openai-compatible" {
		return nil, fmt.Errorf("unsupported provider.kind %q for model listing", cfg.Kind)
	}

	url := strings.TrimRight(cfg.BaseURL, "/") + "/models"
	reqCtx, cancel := context.WithTimeout(ctx, modelsListTimeout)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if cfg.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	}

	client := &http.Client{Timeout: modelsListTimeout}
	res, err := client.Do(httpReq)
	if err != nil {
		return nil, classifyRequestErr(url, err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	var parsed oaiModelsResp
	trimmed := strings.TrimSpace(string(body))
	looksJSON := len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[')
	if looksJSON {
		_ = json.Unmarshal(body, &parsed)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		if parsed.Error != nil && parsed.Error.Message != "" {
			return nil, httpStatusErr(res.StatusCode, url, parsed.Error.Message)
		}
		return nil, httpStatusErr(res.StatusCode, url, string(body))
	}
	if !looksJSON {
		return nil, fmt.Errorf("decode %s: non-JSON body=%s", url, truncate(string(body), 200))
	}

	ids := make([]string, 0, len(parsed.Data))
	for _, m := range parsed.Data {
		id := strings.TrimSpace(m.ID)
		if id != "" {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids, nil
}
