package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/vuuihc/openkin/internal/apns"
	"github.com/vuuihc/openkin/internal/approvemcp"
	"github.com/vuuihc/openkin/internal/daemonlock"
	"github.com/vuuihc/openkin/internal/mcp"
	"github.com/vuuihc/openkin/internal/notify"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/server"
	"github.com/vuuihc/openkin/internal/store"
)

// version is reported by `kin version` and GET /api/version.
// Overridable at link time: -ldflags "-X main.version=…"
var version = "0.0.0-dev"

// stateDirBusyExit is EX_TEMPFAIL. `kin serve` exits with it when another
// daemon already owns the state directory, so a parent — `kin supervise`,
// launchd, the desktop shell — can tell "someone else is serving this machine"
// from a crash and stop restarting into the same refusal.
const stateDirBusyExit = 75

// errStateDirBusy carries that meaning through the supervisor: its child
// refused to start, so the supervisor's own exit reports the same thing.
var errStateDirBusy = errors.New("another kin daemon owns the state directory")

// daemonExitCode maps a serve/supervise failure to the status a parent reads.
func daemonExitCode(err error) int {
	if errors.Is(err, daemonlock.ErrHeld) || errors.Is(err, errStateDirBusy) {
		return stateDirBusyExit
	}
	return 1
}

func main() {
	if len(os.Args) < 2 {
		usage(2)
	}
	switch os.Args[1] {
	case "serve":
		if err := server.Serve(version); err != nil {
			fmt.Fprintf(os.Stderr, "kin serve: %v\n", err)
			os.Exit(daemonExitCode(err))
		}
	case "supervise":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := runSupervise(ctx, os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "kin supervise: %v\n", err)
			os.Exit(daemonExitCode(err))
		}
	case "token":
		if err := runToken(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "kin token: %v\n", err)
			os.Exit(1)
		}
	case "approve-mcp":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := approvemcp.Run(ctx); err != nil {
			fmt.Fprintf(os.Stderr, "kin approve-mcp: %v\n", err)
			os.Exit(1)
		}
	case "mcp":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := runMCP(ctx, os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "kin mcp: %v\n", err)
			os.Exit(1)
		}
	case "notify":
		if err := runNotify(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "kin notify: %v\n", err)
			os.Exit(1)
		}
	case "export":
		if err := runExport(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "kin export: %v\n", err)
			os.Exit(1)
		}
	case "hub":
		if err := runHub(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "kin hub: %v\n", err)
			os.Exit(1)
		}
	case "health":
		if err := runHealth(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "kin health: %v\n", err)
			os.Exit(1)
		}
	case "version":
		fmt.Println(version)
	case "help", "-h", "--help":
		usage(0)
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
		usage(2)
	}
}

// runHealth asks a running daemon whether it is serving. Container health
// checks use it because `kin version` only proves the binary runs: a Hub whose
// HTTP server is wedged would still be reported healthy, and an installer would
// hand out a sign-in link to a page nobody can open.
func runHealth(args []string) error {
	fs := flag.NewFlagSet("health", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	addr := fs.String("addr", "", "daemon base URL (default http://127.0.0.1:$KIN_PORT)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	base := strings.TrimRight(*addr, "/")
	if base == "" {
		port := os.Getenv("KIN_PORT")
		if port == "" {
			port = "7777"
		}
		base = "http://127.0.0.1:" + port
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(base + "/api/health")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %s", base, resp.Status)
	}
	return nil
}

func runMCP(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("mcp", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	stateDir, err := remote.StateDir()
	if err != nil {
		return err
	}
	defaultDaemon := os.Getenv("KIN_DAEMON")
	if defaultDaemon == "" {
		defaultDaemon = "http://127.0.0.1:7777"
	}
	defaultClient := os.Getenv("KIN_MCP_CLIENT")
	if defaultClient == "" {
		defaultClient = "stdio-client"
	}
	daemon := fs.String("daemon", defaultDaemon, "Kin daemon MCP URL")
	client := fs.String("client", defaultClient, "MCP client identity for audit")
	scopes := fs.String("scope", "read,write", "MCP scopes: read,write,admin")
	if err := fs.Parse(args); err != nil {
		return err
	}
	token, err := remote.ReadToken(stateDir)
	if err != nil {
		return fmt.Errorf("read daemon token: %w", err)
	}
	return mcp.RunStdio(ctx, *daemon, token, *client, *scopes, os.Stdin, os.Stdout, os.Stderr)
}

func runHub(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: kin hub init [--email EMAIL] [--domain HOST] | kin hub login-link --email EMAIL [--domain HOST] | kin hub claim-code [--domain HOST] | kin hub accounts | kin hub reset-password --email EMAIL | kin hub invite [--domain HOST] | kin hub node-token [--domain HOST] [--label NAME]")
	}
	switch args[0] {
	case "init":
		fs := flag.NewFlagSet("hub init", flag.ContinueOnError)
		fs.SetOutput(os.Stderr)
		email := fs.String("email", "", "the owner's sign-in address (omit to print a claim link)")
		domain := fs.String("domain", "", "this hub's public hostname, used only to print the link")
		name := fs.String("name", "", "display name for the owner account")
		printURL := fs.Bool("print-url", false, "print only the URL, for scripts and agents")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		return server.RunHubInit(*email, *name, *domain, *printURL)
	case "login-link":
		fs := flag.NewFlagSet("hub login-link", flag.ContinueOnError)
		fs.SetOutput(os.Stderr)
		email := fs.String("email", "", "the account's sign-in address")
		domain := fs.String("domain", "", "this hub's public hostname, used only to print the link")
		printURL := fs.Bool("print-url", false, "print only the URL, for scripts and agents")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		return server.RunHubLoginLink(*email, *domain, *printURL)
	case "claim-code":
		fs := flag.NewFlagSet("hub claim-code", flag.ContinueOnError)
		fs.SetOutput(os.Stderr)
		domain := fs.String("domain", "", "this hub's public hostname, used only to print the link")
		printURL := fs.Bool("print-url", false, "print only the URL, for scripts and agents")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		return server.RunHubClaimCode(*domain, *printURL)
	case "accounts":
		return server.RunHubAccounts()
	case "reset-password":
		fs := flag.NewFlagSet("hub reset-password", flag.ContinueOnError)
		fs.SetOutput(os.Stderr)
		email := fs.String("email", "", "the account's sign-in address")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		return server.RunHubResetPassword(*email)
	case "invite":
		fs := flag.NewFlagSet("hub invite", flag.ContinueOnError)
		fs.SetOutput(os.Stderr)
		domain := fs.String("domain", "", "this hub's public hostname, used only to print the link")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		return server.RunHubInvite(*domain)
	case "node-token":
		fs := flag.NewFlagSet("hub node-token", flag.ContinueOnError)
		fs.SetOutput(os.Stderr)
		domain := fs.String("domain", "", "this hub's public hostname, used only to print the command")
		label := fs.String("label", "", "what to call the machine in the device list")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		return server.RunHubNodeToken(*label, *domain)
	default:
		return fmt.Errorf("unknown hub subcommand %q (want: init, login-link, claim-code, accounts, reset-password, invite, node-token)", args[0])
	}
}

func runToken(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: kin token rotate")
	}
	switch args[0] {
	case "rotate":
		stateDir, err := remote.StateDir()
		if err != nil {
			return err
		}
		tok, err := remote.RotateToken(stateDir)
		if err != nil {
			return err
		}
		fmt.Printf("token rotated: %s\n", remote.TokenFile(stateDir))
		fmt.Printf("new token: %s\n", tok)
		fmt.Println("A running daemon re-reads the token file per request; old token is invalid immediately.")
		return nil
	default:
		return fmt.Errorf("unknown token subcommand %q (want: rotate)", args[0])
	}
}

// runNotify handles `kin notify test` and `kin notify apns`.
//
// The APNs credentials are written here rather than through the settings API:
// the private key must never be readable through a browser session, an export,
// or a backup of the settings response. `test` opens the same database the
// daemon uses, so it exercises the real registry and the real provider token.
func runNotify(args []string) error {
	if len(args) >= 1 && args[0] == "apns" {
		return runNotifyAPNs(args[1:])
	}
	if len(args) < 1 || args[0] != "test" {
		return fmt.Errorf("usage: kin notify test | kin notify apns [flags]")
	}
	stateDir, err := remote.StateDir()
	if err != nil {
		return err
	}
	dbPath := filepath.Join(stateDir, "kin.db")
	st, err := store.Open(dbPath)
	if err != nil {
		return fmt.Errorf("open %s: %w", dbPath, err)
	}
	defer st.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	client, err := apns.FromSettings(ctx, st)
	if err != nil {
		return fmt.Errorf("apns: %w (run `kin notify apns --key-file …`)", err)
	}
	sender := &notify.Sender{Store: st, Devices: st, APNs: client, SessionLive: st.AuthSessionLive}

	payload := notify.Payload{
		Title: "Kin test",
		Body:  "Notification test from kin",
		URL:   sender.DeepLink(ctx, "/settings"),
		Kind:  "test",
		ID:    "test",
		// `kin notify test` is the operator asking every registered phone to
		// ring; it is not work owned by one account.
		Broadcast: true,
	}
	results := sender.Deliver(ctx, payload)
	if len(results) == 0 {
		fmt.Println("no registered iPhone devices (enable notifications in the app's settings)")
		return fmt.Errorf("no devices registered")
	}

	anyOK := false
	for _, r := range results {
		if r.OK {
			anyOK = true
			fmt.Printf("%s %s: ok\n", r.Channel, r.Device)
			continue
		}
		fmt.Printf("%s %s: failed: %s\n", r.Channel, r.Device, r.Error)
	}
	if !anyOK {
		return fmt.Errorf("all devices failed")
	}
	return nil
}

// runNotifyAPNs configures the node's Apple push identity.
func runNotifyAPNs(args []string) error {
	fs := flag.NewFlagSet("notify apns", flag.ContinueOnError)
	keyFile := fs.String("key-file", "", "path to the Apple .p8 signing key")
	keyID := fs.String("key-id", "", "APNs key id (the file name suffix)")
	teamID := fs.String("team-id", "", "Apple developer team id")
	topic := fs.String("topic", "", "bundle id notifications are sent to")
	env := fs.String("env", "production", "production or sandbox")
	status := fs.Bool("status", false, "print whether credentials are configured")
	clear := fs.Bool("clear", false, "remove the configured credentials")
	if err := fs.Parse(args); err != nil {
		return err
	}
	stateDir, err := remote.StateDir()
	if err != nil {
		return err
	}
	dbPath := filepath.Join(stateDir, "kin.db")
	st, err := store.Open(dbPath)
	if err != nil {
		return fmt.Errorf("open %s: %w", dbPath, err)
	}
	defer st.Close()
	ctx := context.Background()

	if *clear {
		if err := st.DeleteSettings(ctx,
			apns.KeyKeyID, apns.KeyTeamID, apns.KeyPrivateKey, apns.KeyTopic, apns.KeyEnvironment,
		); err != nil {
			return err
		}
		fmt.Println("APNs credentials removed")
		return nil
	}
	if *status {
		topic, env, ok := apns.Status(ctx, st)
		if !ok {
			fmt.Println("APNs: not configured")
			return nil
		}
		fmt.Printf("APNs: configured for %s (%s)\n", topic, env)
		return nil
	}
	if *keyFile == "" || *keyID == "" || *teamID == "" || *topic == "" {
		return fmt.Errorf("usage: kin notify apns --key-file AuthKey.p8 --key-id KEYID --team-id TEAMID --topic BUNDLE_ID [--env production]")
	}
	if *env != "production" && *env != "sandbox" {
		return fmt.Errorf("--env must be production or sandbox")
	}
	raw, err := os.ReadFile(*keyFile)
	if err != nil {
		return err
	}
	key, err := apns.ParsePrivateKey(raw)
	if err != nil {
		return err
	}
	if _, err := apns.New(apns.Config{
		KeyID: *keyID, TeamID: *teamID, Topic: *topic,
		Environment: apns.Environment(*env), PrivateKey: key,
	}); err != nil {
		return err
	}
	for key, value := range map[string]string{
		apns.KeyKeyID:       *keyID,
		apns.KeyTeamID:      *teamID,
		apns.KeyPrivateKey:  string(raw),
		apns.KeyTopic:       *topic,
		apns.KeyEnvironment: *env,
	} {
		if err := st.SetSetting(ctx, key, value); err != nil {
			return err
		}
	}
	fmt.Printf("APNs configured for %s (%s)\n", *topic, *env)
	return nil
}

func usage(code int) {
	fmt.Fprintf(os.Stderr, `kin — self-hosted agent console

Usage:
  kin serve [flags]   start the daemon
  kin supervise       run the daemon with bounded crash recovery
  kin token rotate    regenerate ~/.kin/token
  kin notify test     send a test notification to registered iPhones
  kin notify apns     configure the node's Apple push credentials
  kin export --output <path.zip>
  kin approve-mcp     stdio MCP server for Claude Code permission prompts
  kin mcp              public MCP client bridge for local hosts
  kin hub init        claim or sign in: print a claim or one-time sign-in link
  kin hub login-link  mint a one-time sign-in link for an existing account
  kin hub claim-code  print a fresh owner claim code for an unclaimed hub
  kin hub accounts    list the sign-in addresses on this hub
  kin hub reset-password --email EMAIL
                      replace an account's password and print the new one
  kin hub invite      mint a one-time invitation for a second person to join
  kin hub node-token  mint a device token for another machine to run kin node
  kin health          exit nonzero unless the daemon answers /api/health
  kin version         print version
  kin help            show this help

Serve flags:
  --port N              listen port (default 7777)
  --role ROLE           standalone (default) or hub
  --domain HOST         public hostname; required for --role hub
  --acme-email ADDR     Let's Encrypt contact address for --role hub
  --lan                 bind 0.0.0.0; print LAN QR
  --tailscale           serve via tsnet node "kin"
  --funnel              public HTTPS via Funnel (requires --tailscale)
  --relay URL            connect through a user-owned WebSocket relay
  --ts-control-url URL  Headscale/custom control server for tsnet
  --hub URL             run turns for this Hub as well (makes this a Node)
  --token TOKEN         device token for --hub; defaults to ~/.kin/node-token
  --root PATH           an extra directory to run dispatched work in (repeatable)
  --checkout-root PATH  where to keep repositories fetched for a remote console
                        (default <state dir>/checkouts; "off" to fetch none)
  --allow-yolo          let turns dispatched from --hub bypass agent permissions

Environment:
  KIN_STATE_DIR         state directory (default ~/.kin)

Hub sign-in is configured through the environment:
  KIN_OIDC_ISSUER, KIN_OIDC_CLIENT_ID, KIN_OIDC_CLIENT_SECRET,
  KIN_OIDC_DISPLAY_NAME, KIN_OIDC_REDIRECT_URL, KIN_OIDC_BACKCHANNEL_ADDR
`)
	os.Exit(code)
}
