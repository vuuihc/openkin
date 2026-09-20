// Package cloudflare contains the narrow Cloudflare API integration used to
// deploy the user-owned Kin Relay Worker from Desktop settings.
package cloudflare

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/vuuihc/openkin/internal/secret"
	"github.com/vuuihc/openkin/internal/store"
	relayasset "github.com/vuuihc/openkin/relay"
)

const (
	ClientID           = "9b27b83d8a151024729644288ee6bd9a"
	defaultRedirectURI = "http://127.0.0.1:7777/api/cloudflare/oauth/callback"

	defaultAPIBase  = "https://api.cloudflare.com/client/v4"
	defaultAuthURL  = "https://dash.cloudflare.com/oauth2/auth"
	defaultTokenURL = "https://dash.cloudflare.com/oauth2/token"

	defaultScriptName = "kin-relay"
	compatDate        = "2026-09-15"
	oauthScopes       = "workers-scripts.read workers-scripts.write account-settings.read"

	keyAccountID     = "cloudflare.account_id"
	keyAccountName   = "cloudflare.account_name"
	keyScriptName    = "cloudflare.relay_script_name"
	keyWorkerURL     = "cloudflare.relay_worker_url"
	keyLastError     = "cloudflare.relay_last_error"
	keyOAuthState    = "cloudflare.oauth_state"
	keyOAuthExpires  = "cloudflare.oauth_state_expires"
	refOAuthVerifier = "secret-cloudflare-oauth-verifier"
	refOAuthToken    = "secret-cloudflare-oauth-token"
)

var scriptNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// Service owns Cloudflare OAuth and deployment operations.
type Service struct {
	Store       *store.Store
	Secrets     secret.Store
	Client      *http.Client
	APIBase     string
	AuthURL     string
	TokenURL    string
	RedirectURI string
}

type Status struct {
	Authenticated bool   `json:"authenticated"`
	AccountID     string `json:"account_id,omitempty"`
	AccountName   string `json:"account_name,omitempty"`
	ScriptName    string `json:"script_name,omitempty"`
	WorkerURL     string `json:"worker_url,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

type Account struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type DeployRequest struct {
	AccountID  string `json:"account_id"`
	ScriptName string `json:"script_name"`
}

type DeployResult struct {
	AccountID   string `json:"account_id"`
	AccountName string `json:"account_name,omitempty"`
	ScriptName  string `json:"script_name"`
	WorkerURL   string `json:"worker_url"`
}

type tokenSet struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token,omitempty"`
	ExpiresAt    int64  `json:"expires_at"`
}

type cfEnvelope[T any] struct {
	Success bool      `json:"success"`
	Result  T         `json:"result"`
	Errors  []cfError `json:"errors"`
}

type cfError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (s *Service) Status(ctx context.Context) Status {
	get := func(key string) string {
		if s.Store == nil {
			return ""
		}
		v, _ := s.Store.GetSetting(ctx, key)
		return v
	}
	_, tokenErr := s.loadToken()
	return Status{
		Authenticated: tokenErr == nil,
		AccountID:     get(keyAccountID),
		AccountName:   get(keyAccountName),
		ScriptName:    firstNonEmpty(get(keyScriptName), defaultScriptName),
		WorkerURL:     get(keyWorkerURL),
		LastError:     get(keyLastError),
	}
}

func (s *Service) BeginAuth(ctx context.Context) (string, error) {
	if s.Store == nil || s.Secrets == nil {
		return "", errors.New("cloudflare credential store is unavailable")
	}
	state, err := randomString(32)
	if err != nil {
		return "", fmt.Errorf("generate oauth state: %w", err)
	}
	verifier, err := randomString(64)
	if err != nil {
		return "", fmt.Errorf("generate pkce verifier: %w", err)
	}
	if err := s.Secrets.Put(refOAuthVerifier, verifier); err != nil {
		return "", fmt.Errorf("store pkce verifier: %w", err)
	}
	if err := s.Store.SetSettings(ctx, map[string]string{
		keyOAuthState:   state,
		keyOAuthExpires: fmt.Sprintf("%d", time.Now().Add(10*time.Minute).Unix()),
		keyLastError:    "",
	}); err != nil {
		return "", fmt.Errorf("persist oauth state: %w", err)
	}
	params := url.Values{}
	params.Set("response_type", "code")
	params.Set("client_id", ClientID)
	params.Set("redirect_uri", s.redirectURI())
	params.Set("scope", oauthScopes)
	params.Set("state", state)
	params.Set("code_challenge", codeChallenge(verifier))
	params.Set("code_challenge_method", "S256")
	return s.authURL() + "?" + params.Encode(), nil
}

func (s *Service) CompleteAuth(ctx context.Context, state, code string) error {
	if s.Store == nil || s.Secrets == nil {
		return errors.New("cloudflare credential store is unavailable")
	}
	want, _ := s.Store.GetSetting(ctx, keyOAuthState)
	if want == "" || state == "" || state != want {
		_ = s.rememberError(ctx, "invalid Cloudflare OAuth state")
		return errors.New("invalid Cloudflare OAuth state")
	}
	expRaw, _ := s.Store.GetSetting(ctx, keyOAuthExpires)
	var exp int64
	_, _ = fmt.Sscanf(expRaw, "%d", &exp)
	if exp > 0 && time.Now().Unix() > exp {
		_ = s.rememberError(ctx, "Cloudflare OAuth state expired")
		return errors.New("Cloudflare OAuth state expired")
	}
	verifier, err := s.Secrets.Get(refOAuthVerifier)
	if err != nil {
		_ = s.rememberError(ctx, "missing Cloudflare OAuth verifier")
		return fmt.Errorf("read OAuth verifier: %w", err)
	}
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("client_id", ClientID)
	form.Set("redirect_uri", s.redirectURI())
	form.Set("code_verifier", verifier)
	form.Set("code", code)
	token, err := s.exchangeToken(ctx, form)
	if err != nil {
		_ = s.rememberError(ctx, err.Error())
		return err
	}
	if err := s.saveToken(token); err != nil {
		_ = s.rememberError(ctx, err.Error())
		return err
	}
	_ = s.Secrets.Delete(refOAuthVerifier)
	return s.Store.SetSettings(ctx, map[string]string{
		keyOAuthState:   "",
		keyOAuthExpires: "",
		keyLastError:    "",
	})
}

func (s *Service) Accounts(ctx context.Context) ([]Account, error) {
	var out struct {
		Result []Account `json:"result"`
	}
	if err := s.apiJSON(ctx, http.MethodGet, "/accounts", nil, &out); err != nil {
		_ = s.rememberError(ctx, err.Error())
		return nil, err
	}
	return out.Result, nil
}

func (s *Service) DeployRelay(ctx context.Context, req DeployRequest) (DeployResult, error) {
	accountID := strings.TrimSpace(req.AccountID)
	if accountID == "" && s.Store != nil {
		accountID, _ = s.Store.GetSetting(ctx, keyAccountID)
	}
	if accountID == "" {
		return DeployResult{}, errors.New("select a Cloudflare account first")
	}
	scriptName := normalizeScriptName(req.ScriptName)
	if scriptName == "" {
		scriptName = defaultScriptName
	}
	if !scriptNamePattern.MatchString(scriptName) {
		return DeployResult{}, errors.New("Worker name must use lowercase letters, numbers, and hyphens")
	}
	accounts, _ := s.Accounts(ctx)
	accountName := ""
	for _, account := range accounts {
		if account.ID == accountID {
			accountName = account.Name
			break
		}
	}
	if err := s.uploadRelay(ctx, accountID, scriptName); err != nil {
		_ = s.rememberError(ctx, err.Error())
		return DeployResult{}, err
	}
	if err := s.enableScriptSubdomain(ctx, accountID, scriptName); err != nil {
		_ = s.rememberError(ctx, err.Error())
		return DeployResult{}, err
	}
	subdomain, err := s.accountSubdomain(ctx, accountID)
	if err != nil {
		_ = s.rememberError(ctx, err.Error())
		return DeployResult{}, err
	}
	workerURL := fmt.Sprintf("https://%s.%s.workers.dev", scriptName, subdomain)
	if err := s.Store.SetSettings(ctx, map[string]string{
		keyAccountID:   accountID,
		keyAccountName: accountName,
		keyScriptName:  scriptName,
		keyWorkerURL:   workerURL,
		keyLastError:   "",
	}); err != nil {
		return DeployResult{}, err
	}
	return DeployResult{AccountID: accountID, AccountName: accountName, ScriptName: scriptName, WorkerURL: workerURL}, nil
}

func (s *Service) uploadRelay(ctx context.Context, accountID, scriptName string) error {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	metadata := map[string]any{
		"main_module":        "relay.js",
		"compatibility_date": compatDate,
		"bindings": []map[string]string{{
			"type":       "durable_object_namespace",
			"name":       "RELAY_ROOM",
			"class_name": "RelayRoom",
		}},
		"migrations": []map[string]any{{
			"tag":                "v1",
			"new_sqlite_classes": []string{"RelayRoom"},
		}},
	}
	meta, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	metaHeader := make(textproto.MIMEHeader)
	metaHeader.Set("Content-Disposition", `form-data; name="metadata"`)
	metaHeader.Set("Content-Type", "application/json")
	metaPart, err := writer.CreatePart(metaHeader)
	if err != nil {
		return err
	}
	if _, err := metaPart.Write(meta); err != nil {
		return err
	}
	scriptHeader := make(textproto.MIMEHeader)
	scriptHeader.Set("Content-Disposition", `form-data; name="relay.js"; filename="relay.js"`)
	scriptHeader.Set("Content-Type", "application/javascript+module")
	scriptPart, err := writer.CreatePart(scriptHeader)
	if err != nil {
		return err
	}
	if _, err := io.WriteString(scriptPart, relayasset.Source); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	return s.apiJSON(ctx, http.MethodPut, "/accounts/"+url.PathEscape(accountID)+"/workers/scripts/"+url.PathEscape(scriptName), &requestBody{
		contentType: writer.FormDataContentType(),
		body:        &body,
	}, nil)
}

func (s *Service) enableScriptSubdomain(ctx context.Context, accountID, scriptName string) error {
	body := strings.NewReader(`{"enabled":true}`)
	return s.apiJSON(ctx, http.MethodPost, "/accounts/"+url.PathEscape(accountID)+"/workers/scripts/"+url.PathEscape(scriptName)+"/subdomain", &requestBody{
		contentType: "application/json",
		body:        body,
	}, nil)
}

func (s *Service) accountSubdomain(ctx context.Context, accountID string) (string, error) {
	var out cfEnvelope[struct {
		Subdomain string `json:"subdomain"`
	}]
	if err := s.apiJSON(ctx, http.MethodGet, "/accounts/"+url.PathEscape(accountID)+"/workers/subdomain", nil, &out); err != nil {
		return "", err
	}
	if out.Result.Subdomain == "" {
		return "", errors.New("Cloudflare account has no workers.dev subdomain")
	}
	return out.Result.Subdomain, nil
}

type requestBody struct {
	contentType string
	body        io.Reader
}

func (s *Service) apiJSON(ctx context.Context, method, apiPath string, body *requestBody, out any) error {
	access, err := s.accessToken(ctx)
	if err != nil {
		return err
	}
	var reader io.Reader
	contentType := "application/json"
	if body != nil {
		reader = body.body
		contentType = body.contentType
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(s.apiBase(), "/")+apiPath, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("Accept", "application/json")
	if reader != nil {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := s.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("Cloudflare API request: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("Cloudflare API %s %s failed: %s", method, path.Base(apiPath), summarizeCloudflareBody(data))
	}
	var envelope struct {
		Success *bool     `json:"success"`
		Errors  []cfError `json:"errors"`
	}
	if err := json.Unmarshal(data, &envelope); err == nil {
		if envelope.Success != nil && !*envelope.Success {
			return fmt.Errorf("Cloudflare API %s %s failed: %s", method, path.Base(apiPath), summarizeCloudflareBody(data))
		}
		if len(envelope.Errors) > 0 {
			return fmt.Errorf("Cloudflare API %s %s failed: %s", method, path.Base(apiPath), summarizeCloudflareBody(data))
		}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("parse Cloudflare response: %w", err)
	}
	return nil
}

func (s *Service) accessToken(ctx context.Context) (string, error) {
	tok, err := s.loadToken()
	if err != nil {
		return "", errors.New("Cloudflare is not connected")
	}
	if tok.AccessToken != "" && time.Now().Unix() < tok.ExpiresAt-60 {
		return tok.AccessToken, nil
	}
	if tok.RefreshToken == "" {
		return "", errors.New("Cloudflare refresh token is missing")
	}
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("client_id", ClientID)
	form.Set("refresh_token", tok.RefreshToken)
	next, err := s.exchangeToken(ctx, form)
	if err != nil {
		return "", err
	}
	if next.RefreshToken == "" {
		next.RefreshToken = tok.RefreshToken
	}
	if err := s.saveToken(next); err != nil {
		return "", err
	}
	return next.AccessToken, nil
}

func (s *Service) exchangeToken(ctx context.Context, form url.Values) (tokenSet, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.tokenURL(), strings.NewReader(form.Encode()))
	if err != nil {
		return tokenSet{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := s.httpClient().Do(req)
	if err != nil {
		return tokenSet{}, fmt.Errorf("Cloudflare OAuth token request: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return tokenSet{}, fmt.Errorf("Cloudflare OAuth failed: %s", summarizeCloudflareBody(data))
	}
	var raw struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return tokenSet{}, fmt.Errorf("parse Cloudflare OAuth token: %w", err)
	}
	if raw.AccessToken == "" {
		return tokenSet{}, errors.New("Cloudflare OAuth response omitted access token")
	}
	if raw.ExpiresIn <= 0 {
		raw.ExpiresIn = 3600
	}
	return tokenSet{
		AccessToken:  raw.AccessToken,
		RefreshToken: raw.RefreshToken,
		ExpiresAt:    time.Now().Unix() + raw.ExpiresIn,
	}, nil
}

func (s *Service) loadToken() (tokenSet, error) {
	if s.Secrets == nil {
		return tokenSet{}, errors.New("secret store is unavailable")
	}
	raw, err := s.Secrets.Get(refOAuthToken)
	if err != nil {
		return tokenSet{}, err
	}
	var tok tokenSet
	if err := json.Unmarshal([]byte(raw), &tok); err != nil {
		return tokenSet{}, err
	}
	if tok.AccessToken == "" && tok.RefreshToken == "" {
		return tokenSet{}, errors.New("empty token")
	}
	return tok, nil
}

func (s *Service) saveToken(tok tokenSet) error {
	data, err := json.Marshal(tok)
	if err != nil {
		return err
	}
	return s.Secrets.Put(refOAuthToken, string(data))
}

func (s *Service) rememberError(ctx context.Context, msg string) error {
	if s.Store == nil {
		return nil
	}
	return s.Store.SetSetting(ctx, keyLastError, msg)
}

func (s *Service) httpClient() *http.Client {
	if s.Client != nil {
		return s.Client
	}
	return http.DefaultClient
}

func (s *Service) apiBase() string {
	if strings.TrimSpace(s.APIBase) != "" {
		return strings.TrimSpace(s.APIBase)
	}
	return defaultAPIBase
}

func (s *Service) authURL() string {
	if strings.TrimSpace(s.AuthURL) != "" {
		return strings.TrimSpace(s.AuthURL)
	}
	return defaultAuthURL
}

func (s *Service) tokenURL() string {
	if strings.TrimSpace(s.TokenURL) != "" {
		return strings.TrimSpace(s.TokenURL)
	}
	return defaultTokenURL
}

func (s *Service) redirectURI() string {
	if strings.TrimSpace(s.RedirectURI) != "" {
		return strings.TrimSpace(s.RedirectURI)
	}
	return defaultRedirectURI
}

func randomString(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func codeChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func normalizeScriptName(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	value = strings.ReplaceAll(value, "_", "-")
	return value
}

func summarizeCloudflareBody(data []byte) string {
	var env struct {
		Errors []cfError `json:"errors"`
	}
	if json.Unmarshal(data, &env) == nil && len(env.Errors) > 0 {
		parts := make([]string, 0, len(env.Errors))
		for _, err := range env.Errors {
			if err.Message != "" {
				parts = append(parts, err.Message)
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, "; ")
		}
	}
	text := strings.TrimSpace(string(data))
	if text == "" {
		return "empty response"
	}
	if len(text) > 500 {
		return text[:500] + "..."
	}
	return text
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
