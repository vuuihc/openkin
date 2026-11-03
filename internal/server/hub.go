package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/vuuihc/openkin/internal/api"
	authsvc "github.com/vuuihc/openkin/internal/auth"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
)

// Environment variables that configure federated sign-in. They are environment
// only on purpose: a Hub runs as a container, and a client secret must not be
// written into the database, the console, or a support bundle.
const (
	envOIDCIssuer          = "KIN_OIDC_ISSUER"
	envOIDCClientID        = "KIN_OIDC_CLIENT_ID"
	envOIDCClientSecret    = "KIN_OIDC_CLIENT_SECRET"
	envOIDCDisplayName     = "KIN_OIDC_DISPLAY_NAME"
	envOIDCRedirectURL     = "KIN_OIDC_REDIRECT_URL"
	envOIDCBackchannelAddr = "KIN_OIDC_BACKCHANNEL_ADDR"
)

// buildOIDCProvider returns the configured provider, or nil when none is
// configured. Discovery failure is fatal rather than degrading to
// password-only: a Hub that silently loses its configured sign-in method is
// worse than one that refuses to start with a readable error.
func buildOIDCProvider(ctx context.Context, hub *remote.Hub) (*authsvc.OIDCProvider, error) {
	issuer := strings.TrimSpace(os.Getenv(envOIDCIssuer))
	if issuer == "" {
		return nil, nil
	}
	clientID := strings.TrimSpace(os.Getenv(envOIDCClientID))
	if clientID == "" {
		return nil, fmt.Errorf("%s is set but %s is empty", envOIDCIssuer, envOIDCClientID)
	}
	redirectURL := strings.TrimSpace(os.Getenv(envOIDCRedirectURL))
	if redirectURL == "" {
		redirectURL = hub.URL() + "/api/auth/oidc/callback"
	}
	provider, err := authsvc.NewOIDCProvider(ctx, authsvc.OIDCConfig{
		Issuer:          issuer,
		ClientID:        clientID,
		ClientSecret:    os.Getenv(envOIDCClientSecret),
		RedirectURL:     redirectURL,
		DisplayName:     strings.TrimSpace(os.Getenv(envOIDCDisplayName)),
		BackchannelAddr: strings.TrimSpace(os.Getenv(envOIDCBackchannelAddr)),
	})
	if err != nil {
		return nil, fmt.Errorf("configure %s=%s: %w", envOIDCIssuer, issuer, err)
	}
	fmt.Printf("oidc: %s via %s\n", provider.Config().ProviderLabel(), issuer)
	return provider, nil
}

// buildFederationProxy returns the reverse proxy that publishes a same-origin
// identity provider, or nil when the provider lives on its own origin.
func buildFederationProxy(hub *remote.Hub, srvAPI *api.Server) (*federationProxy, error) {
	proxy, err := newFederationProxy(hub, os.Getenv(envOIDCIssuer), os.Getenv(envOIDCBackchannelAddr))
	if err != nil {
		return nil, err
	}
	if proxy == nil {
		return nil, nil
	}
	srvAPI.FederationProxy = proxy
	srvAPI.FederationProxyPath = proxy.Prefix()
	fmt.Printf("oidc: publishing the provider at %s%s\n", hub.URL(), proxy.Prefix())
	return proxy, nil
}

// printBootstrapState tells the operator how to claim a Hub that has no owner
// yet. The code is delivered through the process log because that is the one
// channel a NAS operator already has open, and it is never sent over the
// network or written to the database in the clear.
func printBootstrapState(ctx context.Context, accounts *authsvc.Service, domain string) {
	needs, err := accounts.NeedsBootstrap(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "kin: warning: read account state: %v\n", err)
		return
	}
	if !needs {
		return
	}
	active, err := accounts.BootstrapCodeActive(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "kin: warning: read claim-code state: %v\n", err)
		return
	}
	if active {
		// Reissuing on every restart would invalidate a code the operator has
		// already read off the previous run's log.
		fmt.Println()
		fmt.Println("  This hub has no owner yet, and a claim code is already active.")
		fmt.Println("  Print a fresh one with:  kin hub claim-code")
		fmt.Println()
		return
	}
	code, err := accounts.IssueBootstrapCode(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "kin: warning: issue claim code: %v\n", err)
		return
	}
	printBootstrapCode(code, domain, false)
}

// printBootstrapCode renders a claim code, and the link that carries it when the
// Hub's public hostname is known. printURL is the script-facing mode: one line,
// no box, so an agent can capture it without parsing prose.
func printBootstrapCode(code, domain string, printURL bool) {
	link := claimLink(domain, code)
	if printURL {
		fmt.Println(link)
		return
	}
	fmt.Println()
	fmt.Println("  ┌─────────────────────────────────────────────────────────┐")
	fmt.Println("  │  This hub has no owner yet.                             │")
	fmt.Println("  │  Open the console and enter this claim code:            │")
	fmt.Printf("  │                                                         │\n")
	fmt.Printf("  │      %-51s│\n", code)
	fmt.Printf("  │                                                         │\n")
	fmt.Println("  │  It expires in 24 hours and can be used once.           │")
	fmt.Println("  └─────────────────────────────────────────────────────────┘")
	if link != "" {
		fmt.Printf("\n  Or open this link:  %s\n", link)
	}
	fmt.Println()
}

// RunHubClaimCode implements `kin hub claim-code`, which exists so an operator
// can retrieve a fresh code from a running container without restarting it.
func RunHubClaimCode(domain string, printURL bool) error {
	domain = hubDomain(domain)
	if printURL && domain == "" {
		return fmt.Errorf("pass --domain HOST (the Hub's public hostname) to print a claim link")
	}
	stateDir, err := remote.StateDir()
	if err != nil {
		return err
	}
	st, err := store.Open(filepath.Join(stateDir, "kin.db"))
	if err != nil {
		return err
	}
	defer st.Close()

	ctx := context.Background()
	accounts := authsvc.New(st, authsvc.Config{})
	needs, err := accounts.NeedsBootstrap(ctx)
	if err != nil {
		return err
	}
	if !needs {
		return fmt.Errorf("this hub already has an owner; claim codes are only for an unclaimed hub")
	}
	code, err := accounts.IssueBootstrapCode(ctx)
	if err != nil {
		return err
	}
	printBootstrapCode(code, domain, printURL)
	return nil
}

// RunHubInit implements `kin hub init`, the one command an installer or agent
// needs to get a person into a Hub.
//
// It answers every state the Hub can be in rather than making the caller detect
// it: unclaimed with no address prints a claim link, unclaimed with an address
// creates that owner and prints a sign-in link, and an already-claimed Hub just
// mints a fresh sign-in link. The link is always the last line, so a script can
// capture it, and --print-url makes it the only line.
func RunHubInit(email, displayName, domain string, printURL bool) error {
	domain = hubDomain(domain)
	if printURL && domain == "" {
		return fmt.Errorf("pass --domain HOST (the Hub's public hostname) to print a link")
	}
	stateDir, err := remote.StateDir()
	if err != nil {
		return err
	}
	st, err := store.Open(filepath.Join(stateDir, "kin.db"))
	if err != nil {
		return err
	}
	defer st.Close()

	ctx := context.Background()
	accounts := authsvc.New(st, authsvc.Config{})
	needs, err := accounts.NeedsBootstrap(ctx)
	if err != nil {
		return err
	}
	email = authsvc.NormalizeEmail(email)
	if needs && email == "" {
		code, err := accounts.IssueBootstrapCode(ctx)
		if err != nil {
			return err
		}
		printBootstrapCode(code, domain, printURL)
		return nil
	}
	if needs {
		// The password is generated and deliberately never printed: the link is
		// this account's way in, and a second credential nobody chose would sit
		// in the database unrotated. `kin hub reset-password` can set a known one
		// later if the person wants password sign-in.
		password, err := authsvc.NewPassword()
		if err != nil {
			return err
		}
		code, err := accounts.IssueBootstrapCode(ctx)
		if err != nil {
			return err
		}
		if _, err := accounts.ClaimWithPassword(ctx, code, email, password, displayName,
			authsvc.SessionMeta{UserAgent: "kin hub init", IP: "local"}); err != nil {
			return fmt.Errorf("create the owner account: %w", err)
		}
	}
	if email == "" {
		// Already claimed, and no account was named. A sign-in link has to belong
		// to somebody, so the most this can do is name the front door -- and a
		// front door needs a hostname. Without one, say what is missing instead of
		// printing a relative "/" as if it were an address.
		if printURL {
			fmt.Println(hubOrigin(domain) + "/")
			return nil
		}
		if domain == "" {
			fmt.Println()
			fmt.Println("  This hub already has an owner. Pass --email ADDRESS to mint a sign-in")
			fmt.Println("  link for that account.")
			fmt.Println()
			return nil
		}
		fmt.Printf("\n  This hub already has an owner. Sign in at %s\n", hubOrigin(domain)+"/")
		fmt.Println("  To sign in without a password, pass --email and the link is minted")
		fmt.Println("  for that account.")
		fmt.Println()
		return nil
	}
	user, err := resolveAccountByEmail(ctx, st, email)
	if err != nil {
		return err
	}
	link, err := accounts.IssueLoginLink(ctx, user.ID)
	if err != nil {
		return err
	}
	printLoginLink(user.Email, link, loginLinkURL(domain, link.Token), printURL)
	return nil
}

// RunHubLoginLink implements `kin hub login-link`, the recovery path for an
// account that already exists: a one-time URL that signs in without a password.
//
// It replaces the printed-password handoff for the common case. A reset still
// has its place -- the person may want a password they know -- but "get me back
// into my own Hub" is answered by one link that expires, not by a credential
// that does not.
func RunHubLoginLink(email, domain string, printURL bool) error {
	email = authsvc.NormalizeEmail(email)
	if email == "" {
		return fmt.Errorf("usage: kin hub login-link --email EMAIL [--domain HOST]")
	}
	domain = hubDomain(domain)
	if printURL && domain == "" {
		return fmt.Errorf("pass --domain HOST (the Hub's public hostname) to print a sign-in link")
	}
	stateDir, err := remote.StateDir()
	if err != nil {
		return err
	}
	st, err := store.Open(filepath.Join(stateDir, "kin.db"))
	if err != nil {
		return err
	}
	defer st.Close()

	ctx := context.Background()
	user, err := resolveAccountByEmail(ctx, st, email)
	if err != nil {
		if errors.Is(err, authsvc.ErrAccountNotFound) && !printURL {
			_ = RunHubAccounts()
		}
		return err
	}
	accounts := authsvc.New(st, authsvc.Config{})
	link, err := accounts.IssueLoginLink(ctx, user.ID)
	if err != nil {
		return err
	}
	printLoginLink(user.Email, link, loginLinkURL(domain, link.Token), printURL)
	return nil
}

// resolveAccountByEmail names the account an operator means by an address.
//
// The password identity is checked first because its subject *is* the address,
// which is the exact key a password login uses. Falling back to users.email is
// what makes an account that only signs in with GitHub or Google reachable: it
// has no password identity, and "no password account" would be true and useless.
// More than one match is refused rather than guessed -- users.email is
// deliberately not unique (ADR 0026), so picking one would sign somebody into
// another person's account.
func resolveAccountByEmail(ctx context.Context, st *store.Store, email string) (store.User, error) {
	email = authsvc.NormalizeEmail(email)
	if user, _, err := st.UserByIdentity(ctx, store.ProviderPassword, email); err == nil {
		return user, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return store.User{}, err
	}
	users, err := st.ListUsers(ctx)
	if err != nil {
		return store.User{}, err
	}
	var matches []store.User
	for _, user := range users {
		if authsvc.NormalizeEmail(user.Email) == email {
			matches = append(matches, user)
		}
	}
	switch len(matches) {
	case 0:
		return store.User{}, fmt.Errorf("no account here uses %s: %w",
			printable(email, accountEmailMax), authsvc.ErrAccountNotFound)
	case 1:
		return matches[0], nil
	default:
		return store.User{}, fmt.Errorf("%d accounts use %s; sign in to the one you mean with its password",
			len(matches), printable(email, accountEmailMax))
	}
}

// printLoginLink renders a one-time sign-in URL. The URL is printed on its own
// line rather than in a box because it is longer than the box and copying it is
// the whole point; printURL keeps even the prose out of the way.
func printLoginLink(email string, link authsvc.LoginLink, url string, printURL bool) {
	if printURL {
		fmt.Println(url)
		return
	}
	fmt.Printf("\n  One-time sign-in link for %s\n\n", printable(email, accountEmailMax))
	if url != "" {
		fmt.Printf("      %s\n\n", url)
	} else {
		fmt.Printf("      token: %s\n\n", link.Token)
		fmt.Println("  Pass --domain HOST to print a link instead of a token.")
		fmt.Println()
	}
	fmt.Printf("  It works once and expires %s.\n",
		link.ExpiresAt.Local().Format("2006-01-02 15:04 MST"))
	fmt.Println("  Open it in the browser you use for this Hub; no password is needed.")
	fmt.Println()
}

// loginLinkURL builds the URL that signs the browser in. The token sits in the
// fragment, not the query string: fragments are never sent to a server, so a
// chat client's link preview, a proxy log, or a Referer header cannot spend the
// link before the person does. The console reads it and clears it immediately.
func loginLinkURL(domain, token string) string {
	if strings.TrimSpace(domain) == "" || strings.TrimSpace(token) == "" {
		return ""
	}
	return hubOrigin(domain) + "/#login=" + token
}

// claimLink builds the URL that opens the claim screen with the code in it.
//
// Like a sign-in link, the code rides in the fragment. A claim code is the whole
// proof of ownership of an unclaimed Hub and lives for a day: a chat client's
// link preview, a proxy log, or a Referer would otherwise be enough for whoever
// sees it to claim the Hub first. The console reads the code out of the
// fragment and never sends it as part of a page request. The claim screen still
// accepts `?claim=` for links printed by older versions.
func claimLink(domain, code string) string {
	if strings.TrimSpace(domain) == "" {
		return ""
	}
	return hubOrigin(domain) + "/#claim=" + code
}

// hubDomain resolves the Hub's public hostname from the flag, then from the
// environment the container already has. Keeping the fallback here means every
// `kin hub` command that prints a link agrees about where the Hub is.
func hubDomain(flagValue string) string {
	if domain := strings.TrimSpace(flagValue); domain != "" {
		return domain
	}
	return strings.TrimSpace(os.Getenv("KIN_DOMAIN"))
}

// RunHubAccounts implements `kin hub accounts`, which answers the one question a
// locked-out operator actually has: which address do I sign in with?
//
// The Hub has no user directory over the network on purpose — a member must not
// be able to enumerate the others — so the operator's shell is the only place
// this list may appear.
func RunHubAccounts() error {
	stateDir, err := remote.StateDir()
	if err != nil {
		return err
	}
	st, err := store.Open(filepath.Join(stateDir, "kin.db"))
	if err != nil {
		return err
	}
	defer st.Close()

	ctx := context.Background()
	users, err := st.ListUsers(ctx)
	if err != nil {
		return err
	}
	if len(users) == 0 {
		fmt.Println("This hub has no accounts yet; claim it with `kin hub claim-code`.")
		return nil
	}
	fmt.Println()
	fmt.Println("  Accounts on this hub, by sign-in address:")
	for _, user := range users {
		line := fmt.Sprintf("  %-6s  %s", user.Role, printable(user.Email, accountEmailMax))
		// Which credentials exist is the next question a locked-out operator
		// has, and the answer is already here: an account that signs in with
		// GitHub has no password to reset.
		if methods := signInMethods(ctx, st, user.ID); len(methods) > 0 {
			line += "  sign-in: " + printable(strings.Join(methods, ", "), accountNameMax)
		}
		if user.DisplayName != "" && user.DisplayName != user.Email {
			line += fmt.Sprintf("  (%s)", printable(user.DisplayName, accountNameMax))
		}
		if user.DisabledAt != nil {
			line += "  [disabled]"
		}
		fmt.Println(line)
	}
	fmt.Println()
	return nil
}

// signInMethods names the credentials attached to an account. Labels are
// stored with the identity, so the operator reads "GitHub" rather than an
// issuer URL, and the password credential says "password" like the rest of the
// CLI does.
func signInMethods(ctx context.Context, st *store.Store, userID string) []string {
	identities, err := st.ListIdentities(ctx, userID)
	if err != nil {
		return nil
	}
	seen := make(map[string]bool, len(identities))
	methods := make([]string, 0, len(identities))
	for _, identity := range identities {
		label := strings.TrimSpace(identity.Label)
		if label == "" {
			label = strings.TrimSpace(strings.TrimPrefix(identity.Provider, authsvc.ProviderOIDCPrefix))
		}
		if label == "" || seen[label] {
			continue
		}
		seen[label] = true
		methods = append(methods, label)
	}
	return methods
}

// explainNoPassword answers the case ErrAccountNotFound conflates: the address
// does belong to an account, but that account has no password credential. On a
// Hub that offers federated sign-in this is a normal state, and "no password
// account with that email" would send the operator looking for a typo that is
// not there.
func explainNoPassword(ctx context.Context, st *store.Store, email string) error {
	want := authsvc.NormalizeEmail(email)
	users, err := st.ListUsers(ctx)
	if err != nil {
		return nil
	}
	for _, user := range users {
		if authsvc.NormalizeEmail(user.Email) != want {
			continue
		}
		methods := signInMethods(ctx, st, user.ID)
		how := "a federated login"
		if len(methods) > 0 {
			how = strings.Join(methods, ", ")
		}
		return fmt.Errorf("account %s signs in with %s; there is no password to reset",
			printable(user.Email, accountEmailMax), printable(how, accountNameMax))
	}
	return nil
}

// How much of an account's own text is worth printing. An address longer than
// the RFC limit is not a recoverable typo, and a display name is the one field
// an invited stranger writes: long enough to be a sentence, not long enough to
// bury the rest of the list.
const (
	accountEmailMax = 254
	accountNameMax  = 60
)

// printable makes a stored string safe to put in a terminal.
//
// Both halves of an account are user-supplied — a display name arrives from a
// join form — and neither is validated for characters. Terminals act on control
// characters, so a name carrying ESC can write the clipboard (OSC 52), retitle
// the window, or forge output on the line below. Dropping them loses nothing a
// reader could see, and cutting the value short means one account cannot flood
// the shell it is being listed in.
func printable(s string, max int) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '\t':
			b.WriteRune(' ')
		case r < 0x20, r == 0x7f, r >= 0x80 && r <= 0x9f, invisible(r):
			// A character the terminal obeys and a person cannot read.
		default:
			b.WriteRune(r)
		}
	}
	out := []rune(b.String())
	if len(out) > max {
		return string(out[:max-1]) + "…"
	}
	return string(out)
}

// invisible reports the characters that reorder or hide text without drawing
// anything: bidi embeddings, overrides and isolates, the direction marks, and
// the zero-width space and BOM.
//
// Stripping ESC is not enough on its own. A right-to-left override in a display
// name reverses whatever follows it on the same line, so a member could name
// themselves such that `kin hub accounts` renders another account's address, or
// hides the `[disabled]` marker, while the stored bytes look harmless. Unlike
// ZWJ and ZWNJ, which some scripts need to spell words and emoji need to join,
// nothing in a name needs these.
func invisible(r rune) bool {
	return r == 0x061c || // ARABIC LETTER MARK
		r == 0x200b || // ZERO WIDTH SPACE
		r == 0x200e || r == 0x200f || // LEFT-TO-RIGHT MARK, RIGHT-TO-LEFT MARK
		r >= 0x202a && r <= 0x202e || // LRE, RLE, PDF, LRO, RLO
		r >= 0x2066 && r <= 0x2069 || // LRI, RLI, FSI, PDI
		r == 0xfeff // ZERO WIDTH NO-BREAK SPACE
}

// RunHubResetPassword implements `kin hub reset-password`, the recovery path
// ADR 0022 promised: a command run where the database already lives, rather
// than an emailed link.
//
// It generates the new password instead of taking one as a flag. A password on
// a command line is a password in shell history and in `ps`, and the operator
// has to read this one off the terminal and type it into a phone anyway.
func RunHubResetPassword(email string) error {
	if strings.TrimSpace(email) == "" {
		return fmt.Errorf("usage: kin hub reset-password --email EMAIL")
	}
	stateDir, err := remote.StateDir()
	if err != nil {
		return err
	}
	st, err := store.Open(filepath.Join(stateDir, "kin.db"))
	if err != nil {
		return err
	}
	defer st.Close()

	password, err := authsvc.NewPassword()
	if err != nil {
		return err
	}
	accounts := authsvc.New(st, authsvc.Config{})
	ctx := context.Background()
	user, err := accounts.ResetPassword(ctx, email, password)
	if err != nil {
		if errors.Is(err, authsvc.ErrAccountNotFound) {
			if hint := explainNoPassword(ctx, st, email); hint != nil {
				return hint
			}
			// A typo is the likely cause, and the answer is right here.
			_ = RunHubAccounts()
		}
		return err
	}
	printNewPassword(user.Email, password)
	return nil
}

// printNewPassword shows the generated password once, in the same box the claim
// code uses, because the next thing that happens is typing it into a phone.
//
// The address is printed above the box, not inside it. It is user-supplied text
// in whatever script the account was named in, and the box's right border only
// lines up if every cell is one column wide — a CJK address is two terminal
// columns per rune, so inside the box the last border shifts and wraps. Keeping
// it out makes the alignment independent of the text; it is still sanitized,
// because it is still on its way to a terminal.
func printNewPassword(email, password string) {
	fmt.Println()
	fmt.Printf("  New password for %s\n", printable(email, accountEmailMax))
	fmt.Println()
	fmt.Println("  ┌─────────────────────────────────────────────────────────┐")
	fmt.Printf("  │      %-51s│\n", password)
	fmt.Println("  │                                                         │")
	fmt.Println("  │  Shown once. Every browser session was signed out.      │")
	fmt.Println("  └─────────────────────────────────────────────────────────┘")
	fmt.Println()
}

// RunHubInvite implements `kin hub invite`, which mints a one-time invitation
// for one other person to create their own account on this Hub.
//
// It runs in a shell on the Hub for the reason claim-code and node-token do --
// the operator already has one -- and for one more: an invitation is a
// credential, and the operator already has a private channel to the person they
// are inviting. Putting it on a screen instead would route it through a
// clipboard and a screenshot.
//
// domain, when given, is the Hub's public hostname (the same one `kin serve
// --domain` was started with). It only shapes the link printed at the end.
func RunHubInvite(domain string) error {
	stateDir, err := remote.StateDir()
	if err != nil {
		return err
	}
	st, err := store.Open(filepath.Join(stateDir, "kin.db"))
	if err != nil {
		return err
	}
	defer st.Close()

	ctx := context.Background()
	accounts := authsvc.New(st, authsvc.Config{})
	needs, err := accounts.NeedsBootstrap(ctx)
	if err != nil {
		return err
	}
	// An invitation is issued *by* the account that owns this Hub, so on a Hub
	// with no owner there is nobody to issue one -- and RedeemInvite refuses
	// there anyway. Saying so here names the command that fixes it instead of
	// handing the operator a code that cannot be spent.
	if needs {
		return fmt.Errorf("this hub has no owner yet; claim it with `kin hub claim-code` before inviting anyone")
	}
	invite, err := accounts.IssueInvite(ctx)
	if err != nil {
		return fmt.Errorf("issue invitation: %w", err)
	}
	printInvite(invite, domain)
	return nil
}

// printInvite prints the code, and the link that carries it when the Hub's
// hostname is known.
//
// Both are shown because they fail differently. The link is what a phone can
// open without typing twenty characters; the code is what still works when a
// chat client has mangled the link.
func printInvite(invite authsvc.Invitation, domain string) {
	fmt.Println()
	fmt.Printf("  Invitation code:  %s\n\n", invite.Code)
	if link := inviteLink(domain, invite.Code); link != "" {
		fmt.Printf("  Send this link:   %s\n\n", link)
	}
	fmt.Printf("  It expires %s and can be used once, by one person.\n",
		invite.ExpiresAt.Local().Format("2006-01-02 15:04 MST"))
	fmt.Println("  They choose their own email and password; the account it creates can")
	fmt.Println("  drive this Hub's machines but cannot administer them.")
	fmt.Println()
}

// inviteLink builds the URL that opens the join screen with the code already in
// it, or "" when this Hub's public hostname is unknown.
//
// hubOrigin's fallback is a sentence for a human to read, not a URL -- pasting
// it into a link would produce something that looks right and resolves nowhere.
// With no domain the code is printed alone and the operator appends it to a URL
// they already know. The code's alphabet is uppercase letters, digits and
// dashes, so it needs no escaping in a query string.
func inviteLink(domain, code string) string {
	if strings.TrimSpace(domain) == "" {
		return ""
	}
	return hubOrigin(domain) + "/?invite=" + code
}
