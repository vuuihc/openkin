package server

import (
	"context"
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
func printBootstrapState(ctx context.Context, accounts *authsvc.Service) {
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
	printNewBootstrapCode(ctx, accounts)
}

// printNewBootstrapCode issues and prints a claim code.
func printNewBootstrapCode(ctx context.Context, accounts *authsvc.Service) {
	code, err := accounts.IssueBootstrapCode(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "kin: warning: issue claim code: %v\n", err)
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
	fmt.Println()
}

// RunHubClaimCode implements `kin hub claim-code`, which exists so an operator
// can retrieve a fresh code from a running container without restarting it.
func RunHubClaimCode() error {
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
	printNewBootstrapCode(ctx, accounts)
	return nil
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
