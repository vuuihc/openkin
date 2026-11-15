package api

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"

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
	// Linked is one entry per login credential, with the id the unbind route
	// takes. Identities stays for readers that only need provider names; a
	// chip that can be removed needs the row, and a provider name is not a
	// row — one OIDC issuer can hold several subjects for this account.
	Linked []linkedIdentity `json:"linked,omitempty"`
}

// linkedIdentity is one removable login credential of the signed-in account.
type linkedIdentity struct {
	ID       string `json:"id"`
	Provider string `json:"provider"`
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
		// One provider can hold more than one identity for this account: Dex
		// gives GitHub and Google different subjects, so both connectors can be
		// linked to the same person through the one OIDC provider. The console
		// shows a chip per provider, not per subject, so dedupe here rather
		// than making the client guess.
		seen := make(map[string]bool, len(identities))
		for _, identity := range identities {
			view.Linked = append(view.Linked, linkedIdentity{
				ID:       identity.ID,
				Provider: identity.Provider,
			})
			if seen[identity.Provider] {
				continue
			}
			seen[identity.Provider] = true
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

// handleAuthInvite mints a one-time invitation. The route is operator-gated, so
// reaching this handler already means the caller owns this machine; the code is
// returned in plaintext exactly once, because only its hash is stored.
func (s *Server) handleAuthInvite(w http.ResponseWriter, r *http.Request) {
	if !s.accountsEnabled() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "accounts are not enabled"})
		return
	}
	invite, err := s.Accounts.IssueInvite(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not create an invitation"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"code":       invite.Code,
		"expires_at": invite.ExpiresAt.UnixMilli(),
	})
}

type joinRequest struct {
	Code        string `json:"code"`
	Email       string `json:"email"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name"`
}

// handleAuthJoin creates a member account from an invitation. It is the only
// unauthenticated route that writes a user, so it is rate limited and reports
// every rejection through the same indistinguishable error.
func (s *Server) handleAuthJoin(w http.ResponseWriter, r *http.Request) {
	if !s.accountsEnabled() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "accounts are not enabled"})
		return
	}
	if !s.Auth.AllowAttempt(r) {
		writeJSON(w, http.StatusTooManyRequests, authErrorBody("rate_limited", "too many attempts"))
		return
	}
	var req joinRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	session, err := s.Accounts.RedeemInvite(r.Context(), req.Code, req.Email, req.Password, req.DisplayName, sessionMeta(r))
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

type loginLinkRequest struct {
	Token string `json:"token"`
}

// handleAuthLoginLink spends a one-time sign-in link. It lives beside the
// password login because it answers the same question by a different proof:
// possession of a secret the operator printed on the Hub, rather than a password
// the person chose. The link is consumed even when opening the session then
// fails, which is the safe direction -- a retry needs a new link.
func (s *Server) handleAuthLoginLink(w http.ResponseWriter, r *http.Request) {
	if !s.accountsEnabled() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "accounts are not enabled"})
		return
	}
	if !s.Auth.AllowAttempt(r) {
		writeJSON(w, http.StatusTooManyRequests, authErrorBody("rate_limited", "too many attempts"))
		return
	}
	var req loginLinkRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	session, err := s.Accounts.ConsumeLoginLink(r.Context(), req.Token, sessionMeta(r))
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

type loginCodeRequest struct {
	Code      string `json:"code"`
	DeviceKey string `json:"device_key"`
}

// handleAuthLoginCodeExchange swaps the device-bound code a system-browser
// sign-in handed the app for a one-time login link (G9/T6). The link is what
// the app's own webview opens: the session cookie it sets is first-party for
// the Hub origin the webview is on, which a cookie set on this JSON response
// would not be — the app's webview and the system browser are different cookie
// jars, and the code is the bridge between them.
//
// Device binding is one comparison: the key presented here must equal the key
// the flow started with. Everything else the code guarantees (single use, ≤5
// minutes, hashed at rest) is the store's.
func (s *Server) handleAuthLoginCodeExchange(w http.ResponseWriter, r *http.Request) {
	if !s.accountsEnabled() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "accounts are not enabled"})
		return
	}
	if !s.Auth.AllowAttempt(r) {
		writeJSON(w, http.StatusTooManyRequests, authErrorBody("rate_limited", "too many attempts"))
		return
	}
	var req loginCodeRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	link, err := s.Accounts.ExchangeLoginCode(r.Context(), req.Code, req.DeviceKey, sessionMeta(r))
	if err != nil {
		s.Auth.NoteFailure(r)
		writeJSON(w, http.StatusUnauthorized, authError(err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"login_token": link.Token,
		"expires_at":  link.ExpiresAt.UnixMilli(),
	})
}

func (s *Server) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	if s.accountsEnabled() {
		if cookie, err := r.Cookie(remote.SessionCookieName); err == nil {
			if err := s.Accounts.Logout(r.Context(), cookie.Value); err != nil {
				// The session and its push registrations are deleted in one
				// transaction; a failure leaves both. The browser is still
				// signed out locally, but answering 200 would claim the row is
				// gone when it is not.
				log.Printf("auth: logout: %v", err)
				s.clearSessionCookie(w, r)
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not end the session"})
				return
			}
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

// handleAuthUnlinkIdentity removes one federated login from the signed-in
// account (G19: 合并后可解绑). The id comes from /api/auth/me, which is the
// only place the account's own credential ids appear; asking for another
// account's id answers 404, the same thing an id that never existed answers.
func (s *Server) handleAuthUnlinkIdentity(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "not signed in"})
		return
	}
	// chi's {id} pattern cannot match an empty segment, so a missing id is
	// already 404 by routing — no 400 branch to write.
	id := chi.URLParam(r, "id")
	switch err := s.Accounts.UnlinkIdentity(r.Context(), user.ID, id); {
	case errors.Is(err, auth.ErrLastCredential):
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": "this is the account's only way to sign in; add another login before removing it",
		})
	case errors.Is(err, store.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "identity not found"})
	case err != nil:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not remove the sign-in method"})
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleOIDCStart redirects to the identity provider. When the caller already
// has a session, the flow becomes a link operation instead of a login, which is
// the only way an account ever gains another credential.
//
// A `device_key` query parameter marks the flow as started by the native app
// (G9): the callback then redirects to the app's own scheme with a one-time
// device-bound code instead of setting a cookie, because a Set-Cookie issued
// to the system browser belongs to the browser, not to the app's webview. The
// key is recorded server-side in the pending flow, not on the provider URL —
// the browser hop is untrusted, and the provider echoing a parameter back is
// not proof the app started the flow.
func (s *Server) handleOIDCStart(w http.ResponseWriter, r *http.Request) {
	if s.OIDC == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no identity provider is configured"})
		return
	}
	bindUserID := ""
	if user, ok := s.currentUser(r); ok {
		bindUserID = user.ID
	}
	deviceKey := loginCodeDeviceKey(r.URL.Query().Get("device_key"))
	returnTo := safeReturnTo(r.URL.Query().Get("return_to"))
	authURL, err := s.OIDC.Begin(bindUserID, returnTo, deviceKey)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "start sign-in"})
		return
	}
	http.Redirect(w, r, authURL, http.StatusFound)
}

// handleOIDCCallback completes the flow. It redirects back into the console
// rather than returning JSON, because the browser arrives here by navigation.
//
// An app-initiated flow (recorded server-side at Begin) ends on the app's own
// scheme instead: the app gets a one-time device-bound code, and the session
// cookie is only set later, when the app's own webview spends it. Nothing about
// the account identity crosses the scheme boundary except that code, and the
// device key itself is only ever sent back on an error redirect — the app
// already holds it in memory and presents it at the exchange.
func (s *Server) handleOIDCCallback(w http.ResponseWriter, r *http.Request) {
	if s.OIDC == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no identity provider is configured"})
		return
	}
	query := r.URL.Query()
	if providerErr := query.Get("error"); providerErr != "" {
		// The provider bounced before completing: take the flow out of play and
		// route the failure by where it started.
		req := s.OIDC.Abort(query.Get("state"))
		s.redirectAuthOutcome(w, r, req.DeviceKey(), "", "provider_error", providerErr)
		return
	}
	ident, req, err := s.OIDC.Complete(r.Context(), query.Get("state"), query.Get("code"))
	if err != nil {
		// Complete returns the flow's metadata even on failure (empty only for
		// an unknown or replayed state, which started on no surface at all).
		s.redirectAuthOutcome(w, r, req.DeviceKey(), "", "sign_in_failed", "sign-in could not be completed")
		return
	}
	deviceKey := loginCodeDeviceKey(req.DeviceKey())
	returnTo := safeReturnTo(req.ReturnTo())

	if req.BindUserID() != "" {
		// A link flow is authorized by the session that started it, not by the
		// provider response, so re-check that the session is still valid. A
		// bind flow has no session to hand an anonymous app either way.
		user, ok := s.currentUser(r)
		if !ok || user.ID != req.BindUserID() {
			s.redirectAuthOutcome(w, r, deviceKey, returnTo, "session_expired", "sign in before linking another login")
			return
		}
		if err := s.Accounts.LinkIdentity(r.Context(), user.ID, ident); err != nil {
			s.redirectAuthOutcome(w, r, deviceKey, returnTo, authErrorCode(err), authErrorMessage(err))
			return
		}
		http.Redirect(w, r, withAuthNotice(returnTo, "linked"), http.StatusFound)
		return
	}

	session, err := s.Accounts.LoginIdentity(r.Context(), ident, sessionMeta(r))
	if err != nil {
		s.redirectAuthOutcome(w, r, deviceKey, returnTo, authErrorCode(err), authErrorMessage(err))
		return
	}
	if deviceKey != "" {
		code, cerr := s.Accounts.NewLoginCode(r.Context(), session.User.ID, deviceKey)
		if cerr != nil {
			log.Printf("api: mint login code: %v", cerr)
			redirectLoginCodeError(w, "sign_in_failed", deviceKey)
			return
		}
		redirectLoginCode(w, code.Token)
		return
	}
	s.setSessionCookie(w, r, session)
	http.Redirect(w, r, withAuthNotice(returnTo, "signed-in"), http.StatusFound)
}

// redirectLoginCode sends the app back to its own scheme with the code. The
// target is kin://auth-callback?code=…; ASWebAuthenticationSession turns it
// into the app's callback, and the console's exchange call presents the device
// key the app has held in memory since it started the flow, which is the whole
// of the device binding — the callback URL carries nothing an observer in the
// browser hop could spend.
func redirectLoginCode(w http.ResponseWriter, code string) {
	target := url.URL{Scheme: "kin", Host: "auth-callback"}
	q := url.Values{}
	q.Set("code", code)
	target.RawQuery = q.Encode()
	http.Redirect(w, dummyRequest(), target.String(), http.StatusFound)
}

// redirectAuthOutcome routes a flow's failure to the surface that started it:
// app flows land on kin://auth-callback with the stable code — plus the device
// key, so an app juggling more than one pending flow can tell which one failed
// — and browser flows back into the console with the same parameters the
// console already translates. Successes are handled by the callers directly,
// because both shapes need more than a code (a cookie, or the login code).
func (s *Server) redirectAuthOutcome(w http.ResponseWriter, r *http.Request, deviceKey, returnTo, code, message string) {
	if deviceKey != "" {
		redirectLoginCodeError(w, code, deviceKey)
		return
	}
	s.redirectAuthError(w, r, returnTo, code, message)
}

// redirectLoginCodeError reports a failed app flow on the app's own scheme. The
// stable code is what the console translates; the device key attributes the
// failure to the flow the app started. The AS session completes either way, so
// the app reads the failure from the callback URL rather than waiting on a
// browser that is never coming back.
func redirectLoginCodeError(w http.ResponseWriter, code, deviceKey string) {
	target := url.URL{Scheme: "kin", Host: "auth-callback"}
	q := url.Values{}
	q.Set("error", code)
	if deviceKey != "" {
		q.Set("device_key", deviceKey)
	}
	target.RawQuery = q.Encode()
	http.Redirect(w, dummyRequest(), target.String(), http.StatusFound)
}

// dummyRequest satisfies http.Redirect's referer logic; the scheme the app
// lands on is not derived from the request.
func dummyRequest() *http.Request {
	req, _ := http.NewRequest(http.MethodGet, "https://kin.example.com/api/auth/oidc/callback", nil)
	return req
}

// loginCodeDeviceKey validates the app-supplied device key: a random token the
// app generated, so only shape is checked here. Bound length so it cannot be
// used as a free-form storage slot in a redirect URL.
func loginCodeDeviceKey(raw string) string {
	const maxLen = 128
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > maxLen {
		return ""
	}
	return trimmed
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
	case errors.Is(err, auth.ErrInviteUnavailable):
		return "that invitation is not valid or has expired"
	case errors.Is(err, auth.ErrLoginLinkUnavailable):
		return "that sign-in link is not valid or has expired"
	case errors.Is(err, auth.ErrRegistrationClosed):
		return "this hub already has an owner; sign in instead"
	case errors.Is(err, auth.ErrIdentityNotLinked):
		return "this sign-in is not linked to an account here; sign in with your password, then link it under Settings"
	case errors.Is(err, auth.ErrWeakPassword):
		return err.Error()
	case errors.Is(err, auth.ErrIdentityTaken):
		return "that login is already linked to another account"
	case errors.Is(err, auth.ErrEmailTaken):
		return "that email already has an account here; sign in instead"
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
	case errors.Is(err, auth.ErrInviteUnavailable):
		return "invite_invalid"
	case errors.Is(err, auth.ErrLoginLinkUnavailable):
		return "login_link_invalid"
	case errors.Is(err, auth.ErrLoginCodeUnavailable):
		return "login_code_invalid"
	case errors.Is(err, auth.ErrRegistrationClosed):
		return "registration_closed"
	case errors.Is(err, auth.ErrIdentityNotLinked):
		return "identity_not_linked"
	case errors.Is(err, auth.ErrWeakPassword):
		return "weak_password"
	case errors.Is(err, auth.ErrIdentityTaken):
		return "identity_taken"
	case errors.Is(err, auth.ErrEmailTaken):
		return "email_taken"
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

// clientIPOf returns the address to record as this session's origin.
//
// It goes through remote.ClientIP rather than reading RemoteAddr, because
// middleware.RealIP has folded X-Forwarded-For into RemoteAddr by the time
// handlers run -- so reading it directly would write whatever address the caller
// asked to be recorded as into the session row. The same helper backs the auth
// attempt limiter; there is one answer to "who is asking" and this is it.
func clientIPOf(r *http.Request) string {
	return remote.ClientIP(r)
}
