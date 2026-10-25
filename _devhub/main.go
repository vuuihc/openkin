// Command _devhub serves the built console over plain HTTP against a
// Hub-shaped API server, so the account screens can be driven in a browser.
//
// It is not part of the product and nothing imports it. It exists because the
// browser pass is an acceptance step for the account and permission surfaces
// (docs/plans/2026-10-26-p5-hosted.md §5), and reaching that state through the
// real binary is awkward rather than impossible: `kin serve --role hub` does
// serve plain HTTP on a loopback port (transports are [loopback, hub], and only
// the hub transport sets TLS), but it also binds :443 and :80 for ACME, which
// needs privileges on Linux and fails outright if anything already holds them.
// What this adds on top is state: one command produces a claimed Hub with a live
// invitation, or an unclaimed one with a claim code, which is what the three
// account screens each need to be looked at.
//
// It is a partial Hub -- no terminals, no GitHub, no node relay, no approval
// bridges -- so "the same api.Server the Hub builds" would overstate it. The
// account, session and authorization paths are the real ones.
//
// It lives under a leading underscore, which `go build ./...` and `go vet ./...`
// skip, so `make devhub-build` compiles it on purpose: a main no check owns is a
// main that rots.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"path/filepath"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/api"
	"github.com/vuuihc/openkin/internal/auth"
	"github.com/vuuihc/openkin/internal/hub/workers"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:7799", "listen address")
	state := flag.String("state", "", "state directory (required)")
	static := flag.String("static", "web/dist", "built console directory")
	unclaimed := flag.Bool("unclaimed", false, "leave the hub with no owner, and print its claim code")
	flag.Parse()
	if *state == "" {
		log.Fatal("-state is required")
	}
	// It prints a well-known password, a master token that is in the public
	// repo, and a live invitation code. On loopback that is a fixture; anywhere
	// else it is an open Hub with published credentials.
	if err := mustBeLoopback(*addr); err != nil {
		log.Fatal(err)
	}

	st, err := store.Open(filepath.Join(*state, "kin.db"))
	if err != nil {
		log.Fatal(err)
	}
	defer st.Close()

	eng := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{}, task.NewBus(), 4)
	defer eng.Close()

	ctx := context.Background()
	accounts := auth.New(st, auth.Config{})
	needs, err := accounts.NeedsBootstrap(ctx)
	if err != nil {
		log.Fatal(err)
	}

	if *unclaimed {
		if !needs {
			log.Fatal("this state directory already has an owner; point -state at a fresh one")
		}
		code, err := accounts.IssueBootstrapCode(ctx)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Printf("claim url: http://%s/  with code %s\n", *addr, code)
	} else {
		if needs {
			// Claim the Hub outright, so the invitation below is legal. Doing it
			// here rather than in the browser keeps the check pointed at the
			// join screen rather than at the claim screen.
			code, err := accounts.IssueBootstrapCode(ctx)
			if err != nil {
				log.Fatal(err)
			}
			if _, err := accounts.ClaimWithPassword(ctx, code, "owner@example.com",
				"hunter2hunter2", "Owner", auth.SessionMeta{}); err != nil {
				log.Fatal(err)
			}
		}
		invite, err := accounts.IssueInvite(ctx)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Printf("owner signs in with owner@example.com / hunter2hunter2\n")
		fmt.Printf("join url: http://%s/?invite=%s\n", *addr, invite.Code)
	}

	srv := &api.Server{
		Store:    st,
		Auth:     remote.NewAuth("0000000000000000000000000000000000000000000000000000000000000000"),
		Engine:   eng,
		Version:  "devhub",
		Workers:  workers.NewRegistry(time.Minute, nil),
		Accounts: accounts,
		Static:   http.FileServer(http.Dir(*static)),
	}

	log.Fatal(http.ListenAndServe(*addr, srv.Handler()))
}

// mustBeLoopback refuses to publish a fixture whose credentials are in the repo.
//
// The check is on the host half of the listen address, and an empty host --
// ":7799", which is every interface -- is refused for the same reason a public
// one is.
func mustBeLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("-addr %q: %w", addr, err)
	}
	switch host {
	// SplitHostPort strips the brackets, so "[::1]:7799" arrives here as "::1"
	// and there is no bracketed case to match.
	case "127.0.0.1", "localhost", "::1":
		return nil
	}
	return fmt.Errorf("-addr %q is not loopback: this serves a known password, "+
		"a master token that is in the public repository, and a live invitation code", addr)
}
