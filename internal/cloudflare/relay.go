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
	"sync"
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
	oauthScopes       = "workers-scripts.read workers-scripts.write account-settings.read zone.zone.read"

	keyAccountID     = "cloudflare.account_id"
	keyAccountName   = "cloudflare.account_name"
	keyScriptName    = "cloudflare.relay_script_name"
	keyWorkerURL     = "cloudflare.relay_worker_url"
	keyCustomDomain  = "cloudflare.relay_custom_domain"
	keyCustomURL     = "cloudflare.relay_custom_domain_url"
	keyZoneID        = "cloudflare.relay_zone_id"
	keyZoneName      = "cloudflare.relay_zone_name"
	keyLastError     = "cloudflare.relay_last_error"
	keyAuthenticated = "cloudflare.authenticated"
	keyOAuthState    = "cloudflare.oauth_state"
	keyOAuthExpires  = "cloudflare.oauth_state_expires"
	keyOAuthVerifier = "cloudflare.oauth_verifier"
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
	tokenMu     sync.Mutex
	tokenCache  *tokenSet
}

type Status struct {
	Authenticated bool   `json:"authenticated"`
	AccountID     string `json:"account_id,omitempty"`
	AccountName   string `json:"account_name,omitempty"`
	ScriptName    string `json:"script_name,omitempty"`
	WorkerURL     string `json:"worker_url,omitempty"`
	CustomDomain  string `json:"custom_domain,omitempty"`
	CustomURL     string `json:"custom_url,omitempty"`
	ZoneID        string `json:"zone_id,omitempty"`
	ZoneName      string `json:"zone_name,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

type Account struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Zone struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status,omitempty"`
}

type DeployRequest struct {
	AccountID  string `json:"account_id"`
	ScriptName string `json:"script_name"`
}

type DomainRequest struct {
	AccountID  string `json:"account_id"`
	ZoneID     string `json:"zone_id"`
	Hostname   string `json:"hostname"`
	ScriptName string `json:"script_name"`
}

type DeployResult struct {
	AccountID   string `json:"account_id"`
	AccountName string `json:"account_name,omitempty"`
	ScriptName  string `json:"script_name"`
	WorkerURL   string `json:"worker_url"`
}

type DomainResult struct {
	ID         string `json:"id,omitempty"`
	AccountID  string `json:"account_id"`
	ScriptName string `json:"script_name"`
	ZoneID     string `json:"zone_id"`
	ZoneName   string `json:"zone_name"`
	Hostname   string `json:"hostname"`
	URL        string `json:"url"`
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
	return Status{
		Authenticated: get(keyAuthenticated) == "true",
		AccountID:     get(keyAccountID),
		AccountName:   get(keyAccountName),
		ScriptName:    firstNonEmpty(get(keyScriptName), defaultScriptName),
		WorkerURL:     get(keyWorkerURL),
		CustomDomain:  get(keyCustomDomain),
		CustomURL:     get(keyCustomURL),
		ZoneID:        get(keyZoneID),
		ZoneName:      get(keyZoneName),
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
	if err := s.Store.SetSettings(ctx, map[string]string{
		keyOAuthState:    state,
		keyOAuthExpires:  fmt.Sprintf("%d", time.Now().Add(10*time.Minute).Unix()),
		keyOAuthVerifier: verifier,
		keyLastError:     "",
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
	verifier, _ := s.Store.GetSetting(ctx, keyOAuthVerifier)
	if len(verifier) < 43 {
		_ = s.rememberError(ctx, "missing Cloudflare OAuth verifier")
		return errors.New("missing Cloudflare OAuth verifier")
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
	if err := s.Store.SetSettings(ctx, map[string]string{
		keyOAuthState:    "",
		keyOAuthExpires:  "",
		keyOAuthVerifier: "",
		keyAuthenticated: "true",
		keyLastError:     "",
	}); err != nil {
		return err
	}
	if accounts, err := s.Accounts(ctx); err == nil && len(accounts) == 1 {
		_ = s.Store.SetSettings(ctx, map[string]string{
			keyAccountID:   accounts[0].ID,
			keyAccountName: accounts[0].Name,
			keyLastError:   "",
		})
	}
	return nil
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

func (s *Service) Zones(ctx context.Context, accountID string) ([]Zone, error) {
	accountID = strings.TrimSpace(accountID)
	if accountID == "" && s.Store != nil {
		accountID, _ = s.Store.GetSetting(ctx, keyAccountID)
	}
	apiPath := "/zones?per_page=50&status=active"
	if accountID != "" {
		apiPath += "&account.id=" + url.QueryEscape(accountID)
	}
	var out struct {
		Result []Zone `json:"result"`
	}
	if err := s.apiJSON(ctx, http.MethodGet, apiPath, nil, &out); err != nil {
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

func (s *Service) BindRelayDomain(ctx context.Context, req DomainRequest) (DomainResult, error) {
	if s.Store == nil {
		return DomainResult{}, errors.New("cloudflare settings store is unavailable")
	}
	accountID := strings.TrimSpace(req.AccountID)
	if accountID == "" && s.Store != nil {
		accountID, _ = s.Store.GetSetting(ctx, keyAccountID)
	}
	if accountID == "" {
		return DomainResult{}, errors.New("select a Cloudflare account first")
	}
	scriptName := normalizeScriptName(req.ScriptName)
	if scriptName == "" && s.Store != nil {
		scriptName, _ = s.Store.GetSetting(ctx, keyScriptName)
	}
	if scriptName == "" {
		scriptName = defaultScriptName
	}
	if !scriptNamePattern.MatchString(scriptName) {
		return DomainResult{}, errors.New("Worker name must use lowercase letters, numbers, and hyphens")
	}
	zoneID := strings.TrimSpace(req.ZoneID)
	if zoneID == "" && s.Store != nil {
		zoneID, _ = s.Store.GetSetting(ctx, keyZoneID)
	}
	if zoneID == "" {
		return DomainResult{}, errors.New("select a Cloudflare zone first")
	}
	zones, err := s.Zones(ctx, accountID)
	if err != nil {
		return DomainResult{}, err
	}
	var zone Zone
	for _, candidate := range zones {
		if candidate.ID == zoneID {
			zone = candidate
			break
		}
	}
	if zone.ID == "" {
		return DomainResult{}, errors.New("selected Cloudflare zone was not found")
	}
	hostname := normalizeHostname(req.Hostname)
	if hostname == "" {
		hostname = "kin-relay." + zone.Name
	}
	if !hostnameBelongsToZone(hostname, zone.Name) {
		return DomainResult{}, fmt.Errorf("hostname must be %s or a subdomain of %s", zone.Name, zone.Name)
	}
	result, err := s.attachWorkerDomain(ctx, accountID, zone.ID, hostname, scriptName)
	if err != nil {
		_ = s.rememberError(ctx, err.Error())
		return DomainResult{}, err
	}
	if result.Hostname == "" {
		result.Hostname = hostname
	}
	if result.ZoneName == "" {
		result.ZoneName = zone.Name
	}
	if result.ZoneID == "" {
		result.ZoneID = zone.ID
	}
	return DomainResult{
		AccountID:  accountID,
		ScriptName: scriptName,
		ZoneID:     result.ZoneID,
		ZoneName:   result.ZoneName,
		Hostname:   result.Hostname,
		URL:        "https://" + result.Hostname,
		ID:         result.ID,
	}, nil
}

func (s *Service) RememberRelayDomain(ctx context.Context, result DomainResult) error {
	if s.Store == nil {
		return errors.New("cloudflare settings store is unavailable")
	}
	return s.Store.SetSettings(ctx, map[string]string{
		keyAccountID:    result.AccountID,
		keyScriptName:   result.ScriptName,
		keyCustomDomain: result.Hostname,
		keyCustomURL:    result.URL,
		keyZoneID:       result.ZoneID,
		keyZoneName:     result.ZoneName,
		keyLastError:    "",
	})
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
		"migrations": map[string]any{
			"new_sqlite_classes": []string{"RelayRoom"},
		},
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

func (s *Service) attachWorkerDomain(ctx context.Context, accountID, zoneID, hostname, scriptName string) (DomainResult, error) {
	bodyBytes, err := json.Marshal(map[string]string{
		"hostname": hostname,
		"service":  scriptName,
		"zone_id":  zoneID,
	})
	if err != nil {
		return DomainResult{}, err
	}
	var out cfEnvelope[struct {
		ID       string `json:"id"`
		Hostname string `json:"hostname"`
		Service  string `json:"service"`
		ZoneID   string `json:"zone_id"`
		ZoneName string `json:"zone_name"`
	}]
	if err := s.apiJSON(ctx, http.MethodPut, "/accounts/"+url.PathEscape(accountID)+"/workers/domains", &requestBody{
		contentType: "application/json",
		body:        bytes.NewReader(bodyBytes),
	}, &out); err != nil {
		return DomainResult{}, err
	}
	return DomainResult{
		ID:         out.Result.ID,
		AccountID:  accountID,
		ScriptName: firstNonEmpty(out.Result.Service, scriptName),
		ZoneID:     firstNonEmpty(out.Result.ZoneID, zoneID),
		ZoneName:   out.Result.ZoneName,
		Hostname:   firstNonEmpty(out.Result.Hostname, hostname),
	}, nil
}

func (s *Service) DetachRelayDomain(ctx context.Context, accountID, domainID string) error {
	accountID = strings.TrimSpace(accountID)
	domainID = strings.TrimSpace(domainID)
	if accountID == "" || domainID == "" {
		return nil
	}
	return s.apiJSON(ctx, http.MethodDelete, "/accounts/"+url.PathEscape(accountID)+"/workers/domains/"+url.PathEscape(domainID), nil, nil)
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
	s.tokenMu.Lock()
	if s.tokenCache != nil {
		tok := *s.tokenCache
		s.tokenMu.Unlock()
		return tok, nil
	}
	s.tokenMu.Unlock()
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
	s.tokenMu.Lock()
	s.tokenCache = &tok
	s.tokenMu.Unlock()
	return tok, nil
}

func (s *Service) saveToken(tok tokenSet) error {
	data, err := json.Marshal(tok)
	if err != nil {
		return err
	}
	if err := s.Secrets.Put(refOAuthToken, string(data)); err != nil {
		return err
	}
	s.tokenMu.Lock()
	s.tokenCache = &tok
	s.tokenMu.Unlock()
	return nil
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

func normalizeHostname(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	value = strings.TrimPrefix(value, "https://")
	value = strings.TrimPrefix(value, "http://")
	value = strings.TrimSuffix(value, ".")
	if slash := strings.IndexByte(value, '/'); slash >= 0 {
		value = value[:slash]
	}
	return value
}

func hostnameBelongsToZone(hostname, zoneName string) bool {
	hostname = normalizeHostname(hostname)
	zoneName = normalizeHostname(zoneName)
	return hostname == zoneName || strings.HasSuffix(hostname, "."+zoneName)
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
