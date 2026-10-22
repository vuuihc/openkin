package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/vuuihc/openkin/internal/auth"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
)

// authStatus is the login surface's whole view of the Hub's account state. It
// is served unauthenticated, so it must not leak anything an anonymous visitor
// should not see: it never includes emails, user ids, or whether a code exists
// beyond the boolean the claim page already depends on.
type authStatus struct {
	NeedsBootstrap bool           `json:"needs_bootstrap"`
	Claimable      bool           `json:"claimable"`
	Authenticated  bool           `json:"authenticated"`
	Providers      []authProvider `json:"providers"`
	User           *authUser      `json:"user,omitempty"`
}

type authProvider struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Kind     string `json:"kind"` // "password" | "oidc"
	StartURL string `json:"start_url,omitempty"`
}

type authUser struct {
	ID            string   `json:"id"`
	Email         string   `json:"email,omitempty"`
	EmailVerified bool     `json:"email_verified"`
	EmailSource   string   `json:"email_source,omitempty"`
	DisplayName   string   `json:"display_name,omitempty"`
	Identities    []string `json:"identities,omitempty"`
}

// accountsEnabled reports whether this process has an account system at all.
// Standalone daemons keep the token-only behavior they have always had.
func (s *Server) accountsEnabled() bool {
	return s.Accounts != nil
}

func (s *Server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	if !s.accountsEnabled() {
		// A standalone daemon has no accounts; the console keeps using its token.
		writeJSON(w, http.StatusOK, authStatus{Providers: []authProvider{}})
		return
	}
	out := authStatus{Providers: s.authProviders()}
	needs, err := s.Accounts.NeedsBootstrap(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "read account state"})
		return
	}
	out.NeedsBootstrap = needs
	if needs {
		active, err := s.Accounts.BootstrapCodeActive(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "read account state"})
			return
		}
		out.Claimable = active
	}
	if user, ok := s.currentUser(r); ok {
		out.Authenticated = true
		out.User = s.authUserView(r, user)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) authProviders() []authProvider {
	out := []authProvider{{ID: store.ProviderPassword, Label: "password", Kind: "password"}}
	if s.OIDC != nil {
		cfg := s.OIDC.Config()
		out = append(out, authProvider{
			ID:       cfg.ProviderKey(),
			Label:    cfg.ProviderLabel(),
			Kind:     "oidc",
			StartURL: "/api/auth/oidc/start",
		})
	}
	return out
}

func (s *Server) authUserView(r *http.Request, user store.User) *authUser {
	view := &authUser{
		ID:            user.ID,
		Email:         user.Email,
		EmailVerified: user.EmailVerified,
		EmailSource:   user.EmailSource,
		DisplayName:   user.DisplayName,
	}
	if identities, err := s.Store.ListIdentities(r.Context(), user.ID); err == nil {
		for _, identity := range identities {
			view.Identities = append(view.Identities, identity.Provider)
		}
	}
	return view
}

// currentUser returns the account behind the request's login cookie.
//
// It reads the cookie directly instead of the request principal because the
// endpoints that need it most — the status probe and the OIDC link flow — sit
// outside the authenticated route group by necessity: they must answer an
// anonymous caller rather than reject one.
func (s *Server) currentUser(r *http.Request) (store.User, bool) {
	if s.Accounts == nil {
		return store.User{}, false
	}
	cookie, err := r.Cookie(remote.SessionCookieName)
	if err != nil || cookie.Value == "" {
		return store.User{}, false
	}
	user, err := s.Accounts.Authenticate(r.Context(), cookie.Value)
	if err != nil {
		return store.User{}, false
	}
	return user, true
}

type bootstrapRequest struct {
	Code        string `json:"code"`
	Email       string `json:"email"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name"`
}

func (s *Server) handleAuthBootstrap(w http.ResponseWriter, r *http.Request) {
	if !s.accountsEnabled() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "accounts are not enabled"})
		return
	}
	if !s.Auth.AllowAttempt(r) {
		writeJSON(w, http.StatusTooManyRequests, authErrorBody("rate_limited", "too many attempts"))
		return
	}
	var req bootstrapRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	session, err := s.Accounts.ClaimWithPassword(r.Context(), req.Code, req.Email, req.Password, req.DisplayName, sessionMeta(r))
	if err != nil {
		s.Auth.NoteFailure(r)
		writeJSON(w, http.StatusBadRequest, authError(err))
		return
	}
	s.setSessionCookie(w, r, session)
	writeJSON(w, http.StatusOK, map[string]any{
		"user":       s.authUserView(r, session.User),
		"expires_at": session.ExpiresAt.UnixMilli(),
	})
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	if !s.accountsEnabled() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "accounts are not enabled"})
		return
	}
	if !s.Auth.AllowAttempt(r) {
		writeJSON(w, http.StatusTooManyRequests, authErrorBody("rate_limited", "too many attempts"))
		return
	}
	var req loginRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	session, err := s.Accounts.LoginPassword(r.Context(), req.Email, req.Password, sessionMeta(r))
	if err != nil {
		s.Auth.NoteFailure(r)
		writeJSON(w, http.StatusUnauthorized, authError(err))
		return
	}
	s.setSessionCookie(w, r, session)
	writeJSON(w, http.StatusOK, map[string]any{
		"user":       s.authUserView(r, session.User),
		"expires_at": session.ExpiresAt.UnixMilli(),
	})
}

func (s *Server) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	if s.accountsEnabled() {
		if cookie, err := r.Cookie(remote.SessionCookieName); err == nil {
			_ = s.Accounts.Logout(r.Context(), cookie.Value)
		}
	}
	s.clearSessionCookie(w, r)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleAuthMe(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "not signed in"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": s.authUserView(r, user)})
}

// handleOIDCStart redirects to the identity provider. When the caller already
// has a session, the flow becomes a link operation instead of a login, which is
// the only way an account ever gains another credential.
func (s *Server) handleOIDCStart(w http.ResponseWriter, r *http.Request) {
	if s.OIDC == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no identity provider is configured"})
		return
	}
	bindUserID := ""
	if user, ok := s.currentUser(r); ok {
		bindUserID = user.ID
	}
	returnTo := safeReturnTo(r.URL.Query().Get("return_to"))
	url, err := s.OIDC.Begin(bindUserID, returnTo)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "start sign-in"})
		return
	}
	http.Redirect(w, r, url, http.StatusFound)
}

// handleOIDCCallback completes the flow. It redirects back into the console
// rather than returning JSON, because the browser arrives here by navigation.
func (s *Server) handleOIDCCallback(w http.ResponseWriter, r *http.Request) {
	if s.OIDC == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no identity provider is configured"})
		return
	}
	query := r.URL.Query()
	if providerErr := query.Get("error"); providerErr != "" {
		s.redirectAuthError(w, r, "", "provider_error", providerErr)
		return
	}
	ident, req, err := s.OIDC.Complete(r.Context(), query.Get("state"), query.Get("code"))
	if err != nil {
		s.redirectAuthError(w, r, "", "sign_in_failed", "sign-in could not be completed")
		return
	}
	returnTo := safeReturnTo(req.ReturnTo())

	if req.BindUserID() != "" {
		// A link flow is authorized by the session that started it, not by the
		// provider response, so re-check that the session is still valid.
		user, ok := s.currentUser(r)
		if !ok || user.ID != req.BindUserID() {
			s.redirectAuthError(w, r, returnTo, "session_expired", "sign in before linking another login")
			return
		}
		if err := s.Accounts.LinkIdentity(r.Context(), user.ID, ident); err != nil {
			s.redirectAuthError(w, r, returnTo, authErrorCode(err), authErrorMessage(err))
			return
		}
		http.Redirect(w, r, withAuthNotice(returnTo, "linked"), http.StatusFound)
		return
	}

	session, err := s.Accounts.LoginIdentity(r.Context(), ident, sessionMeta(r))
	if err != nil {
		s.redirectAuthError(w, r, returnTo, authErrorCode(err), authErrorMessage(err))
		return
	}
	s.setSessionCookie(w, r, session)
	http.Redirect(w, r, withAuthNotice(returnTo, "signed-in"), http.StatusFound)
}

// redirectAuthError bounces the browser back into the console with the failure
// attached to the URL. The code is what the console translates; the message is
// a fallback, and is the only place a provider's own error text can appear.
func (s *Server) redirectAuthError(w http.ResponseWriter, r *http.Request, returnTo, code, message string) {
	target := withAuthNotice(safeReturnTo(returnTo), "")
	http.Redirect(w, r, target+"auth_error="+url.QueryEscape(message)+
		"&auth_error_code="+url.QueryEscape(code), http.StatusFound)
}

func (s *Server) setSessionCookie(w http.ResponseWriter, r *http.Request, session auth.Session) {
	http.SetCookie(w, &http.Cookie{
		Name:     remote.SessionCookieName,
		Value:    session.Token,
		Path:     "/",
		Expires:  session.ExpiresAt,
		HttpOnly: true,
		// Secure is set from the request so a plain-HTTP standalone daemon on
		// loopback still works; a Hub behind TLS always gets it.
		Secure:   requestIsSecure(r),
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Server) clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     remote.SessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   requestIsSecure(r),
		SameSite: http.SameSiteLaxMode,
	})
}

func requestIsSecure(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func sessionMeta(r *http.Request) auth.SessionMeta {
	return auth.SessionMeta{
		UserAgent: r.UserAgent(),
		IP:        clientIPOf(r),
	}
}

// authErrorMessage maps internal errors to text safe for an unauthenticated
// caller. Anything unrecognized collapses to a generic message so internal
// detail never reaches the login page.
func authErrorMessage(err error) string {
	switch {
	case errors.Is(err, auth.ErrInvalidCredentials):
		return "email or password is incorrect"
	case errors.Is(err, auth.ErrBootstrapUnavailable):
		return "that claim code is not valid or has expired"
	case errors.Is(err, auth.ErrRegistrationClosed):
		return "this hub already has an owner; sign in instead"
	case errors.Is(err, auth.ErrWeakPassword):
		return err.Error()
	case errors.Is(err, auth.ErrIdentityTaken):
		return "that login is already linked to another account"
	default:
		return "sign-in failed"
	}
}

// authErrorCode is the stable half of an auth error. Clients translate the
// code; the message above is only a fallback for a client that does not
// recognize it. Without this the console would have to match on English prose.
func authErrorCode(err error) string {
	switch {
	case errors.Is(err, auth.ErrInvalidCredentials):
		return "invalid_credentials"
	case errors.Is(err, auth.ErrBootstrapUnavailable):
		return "claim_code_invalid"
	case errors.Is(err, auth.ErrRegistrationClosed):
		return "registration_closed"
	case errors.Is(err, auth.ErrWeakPassword):
		return "weak_password"
	case errors.Is(err, auth.ErrIdentityTaken):
		return "identity_taken"
	default:
		return "sign_in_failed"
	}
}

func authErrorBody(code, message string) map[string]string {
	return map[string]string{"error": message, "code": code}
}

func authError(err error) map[string]string {
	return authErrorBody(authErrorCode(err), authErrorMessage(err))
}

// safeReturnTo accepts only a local absolute path, so a crafted return_to
// cannot bounce a freshly authenticated browser to another origin.
func safeReturnTo(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || !strings.HasPrefix(trimmed, "/") {
		return "/"
	}
	// "//host" and "/\host" are protocol-relative and leave the origin.
	if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "/\\") {
		return "/"
	}
	return trimmed
}

func withAuthNotice(returnTo, notice string) string {
	target := safeReturnTo(returnTo)
	separator := "?"
	if strings.Contains(target, "?") {
		separator = "&"
	}
	if notice == "" {
		return target + separator
	}
	return target + separator + "auth_notice=" + url.QueryEscape(notice)
}

// decodeJSONBody reads a JSON request body with a size cap and reports whether
// decoding succeeded, writing the error response itself when it did not.
func decodeJSONBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	// 64 KiB is far more than any auth payload needs and keeps a hostile caller
	// from making the daemon buffer something unbounded.
	body := http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return false
	}
	return true
}

// clientIPOf returns the request's peer address. middleware.RealIP has already
// folded X-Forwarded-For into RemoteAddr by the time handlers run.
func clientIPOf(r *http.Request) string {
	return r.RemoteAddr
}
