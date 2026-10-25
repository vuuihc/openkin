package worker

import (
	"errors"
	"strings"
	"testing"
)

// A question's envelope is checked here; which questions exist is the answering
// machine's business.
//
// A Hub on a newer version asks something an older Node has never heard of, and
// the useful outcome is that Node saying so — an envelope that refused the
// question before it could be read would leave the Hub waiting for an answer
// that is never coming.
func TestQueryValidationChecksShapeNotVocabulary(t *testing.T) {
	for _, tc := range []struct {
		name  string
		query Query
		// field is the word the refusal has to name, or empty when the question
		// is one this package accepts.
		field string
	}{
		{name: "no id", query: Query{Method: QueryListDirs}, field: "id"},
		{name: "blank id", query: Query{ID: "  ", Method: QueryListDirs}, field: "id"},
		{name: "no method", query: Query{ID: "q-1"}, field: "method"},
		{name: "id over the bound", query: Query{ID: strings.Repeat("i", MaxQueryID+1), Method: QueryListDirs}, field: "id"},
		{name: "method over the bound", query: Query{ID: "q-1", Method: strings.Repeat("m", MaxMethod+1)}, field: "method"},
		{name: "params over the bound", query: Query{ID: "q-1", Method: QueryListDirs, Params: make([]byte, MaxQueryParams+1)}, field: "params"},
		{name: "a method this package does not know", query: Query{ID: "q-1", Method: "fs.wat"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.query.Validate()
			if tc.field == "" {
				if err != nil {
					t.Fatalf("Validate() = %v, want the envelope to accept it", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("Validate() accepted a question with %s", tc.name)
			}
			if !strings.Contains(err.Error(), tc.field) {
				t.Fatalf("Validate() = %q, want it to name %q", err, tc.field)
			}
		})
	}
}

// An answer is a payload or a reason, and a Hub reads the reason as one.
func TestQueryResultCarriesAnAnswerOrAReason(t *testing.T) {
	answer, err := Answer("q-1", ListDirsResult{Path: "/code", Entries: []string{"kin"}})
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if err := answer.Validate(); err != nil {
		t.Fatalf("Answer produced an invalid result: %v", err)
	}
	var listed ListDirsResult
	if err := answer.Into(&listed); err != nil {
		t.Fatalf("Into: %v", err)
	}
	if listed.Path != "/code" || len(listed.Entries) != 1 {
		t.Fatalf("Into decoded %+v", listed)
	}

	refused, err := Refuse("q-2", errors.New("/etc is not a directory this machine works in"))
	if err != nil {
		t.Fatalf("Refuse: %v", err)
	}
	if err := refused.Validate(); err != nil {
		t.Fatalf("Refuse produced an invalid result: %v", err)
	}
	if err := refused.Into(&listed); err == nil {
		t.Fatal("Into accepted a refusal as an answer")
	} else if !strings.Contains(err.Error(), "not a directory this machine works in") {
		t.Fatalf("Into = %q, want the machine's own reason", err)
	}

	// An answer with neither half is a machine that is broken, not a question
	// that was refused. It is a valid envelope — refusing the frame would turn a
	// broken answer into a Hub waiting for one that never comes — and it fails
	// where it is read, with a sentence.
	empty := QueryResult{ID: "q-3"}
	if err := empty.Validate(); err != nil {
		t.Fatalf("an empty answer is a readable frame: %v", err)
	}
	if err := empty.Into(&listed); err == nil {
		t.Fatal("Into accepted an answer with no payload and no reason")
	} else if !strings.Contains(err.Error(), "q-3") {
		t.Fatalf("Into = %q, want it to name the answer it could not read", err)
	}
	if _, err := Answer("  ", ListDirsResult{}); err == nil {
		t.Fatal("Answer built a result for an unnamed question")
	}
}

// The path rule is the same one Executor.allowedCwd states for a dispatch: the
// Hub speaks in paths on the machine, so a relative path is not a question this
// protocol accepts — it would resolve against whatever directory the daemon was
// started in, which is not a choice the Hub gets to make.
func TestListDirsParamsRequireAnAbsolutePath(t *testing.T) {
	if err := (ListDirsParams{}).Validate(); err != nil {
		t.Fatalf("an empty path is the machine's own roots, not an error: %v", err)
	}
	if err := (ListDirsParams{Path: "/code/kin"}).Validate(); err != nil {
		t.Fatalf("an absolute path was refused: %v", err)
	}
	if err := (ListDirsParams{Path: "code/kin"}).Validate(); err == nil {
		t.Fatal("a relative path was accepted")
	}
	if err := (ListDirsParams{Path: strings.Repeat("p", MaxCwd+1)}).Validate(); err == nil {
		t.Fatal("an oversized path was accepted")
	}
}

// A repository and a branch are names, and a name must not be able to become an
// option.
//
// Both end up as arguments to git on a machine the Hub is not: `ls-remote
// --upload-pack=` runs whatever it is pointed at, and `checkout -f` throws away
// work in a directory somebody is using. The Hub is the other party on this
// channel, so this is decided here, before the question is sent, rather than
// trusted to the side that did not choose the name.
func TestRepoQuestionsRefuseANameThatIsAnOption(t *testing.T) {
	for _, tc := range []struct {
		name   string
		params interface{ Validate() error }
		// field is the word the refusal has to name, or empty when the question
		// is one this package accepts.
		field string
	}{
		{name: "an ordinary shorthand", params: RepoBranchesParams{Repo: "owner/repo"}},
		{name: "a full url", params: RepoBranchesParams{Repo: "https://github.com/owner/repo.git"}},
		{name: "a local path", params: RepoBranchesParams{Repo: "/srv/git/repo.git"}},

		{name: "no repo", params: RepoBranchesParams{}, field: "repo"},
		{name: "blank repo", params: RepoBranchesParams{Repo: "  "}, field: "repo"},
		{name: "repo over the bound", params: RepoBranchesParams{Repo: strings.Repeat("r", MaxRepo+1)}, field: "repo"},
		{name: "repo that is an option", params: RepoBranchesParams{Repo: "--upload-pack=/bin/sh"}, field: "dash"},
		{name: "repo with a newline", params: RepoBranchesParams{Repo: "owner/repo\n--upload-pack=/bin/sh"}, field: "control"},

		{name: "prepare without a branch", params: RepoPrepareParams{Repo: "owner/repo"}},
		{name: "prepare with a branch", params: RepoPrepareParams{Repo: "owner/repo", Branch: "main"}},

		{name: "prepare with no repo", params: RepoPrepareParams{Branch: "main"}, field: "repo"},
		{name: "branch that is an option", params: RepoPrepareParams{Repo: "owner/repo", Branch: "-f"}, field: "dash"},
		{name: "branch with a newline", params: RepoPrepareParams{Repo: "owner/repo", Branch: "main\n-f"}, field: "control"},
		{name: "branch over the bound", params: RepoPrepareParams{Repo: "owner/repo", Branch: strings.Repeat("b", MaxBranch+1)}, field: "branch"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.params.Validate()
			if tc.field == "" {
				if err != nil {
					t.Fatalf("Validate() = %v, want it accepted", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("Validate() accepted %s", tc.name)
			}
			if !strings.Contains(err.Error(), tc.field) {
				t.Fatalf("Validate() = %q, want it to name %q", err, tc.field)
			}
		})
	}
}

// A title is bounded the way GitHub bounds it — in characters — because the person
// writing it may be writing Chinese or Japanese. 256 of those characters is 768
// bytes, and a bound counted in bytes would refuse the title rather than the
// length: a message about a limit nobody reached, in the language they wrote it in.
func TestATitleIsBoundedInCharactersRatherThanBytes(t *testing.T) {
	atBound := strings.Repeat("标", MaxPRTitle)
	if err := ValidatePRWords(atBound, ""); err != nil {
		t.Fatalf("a title of %d characters (%d bytes) was refused: %v",
			MaxPRTitle, len(atBound), err)
	}
	if err := ValidatePRWords(atBound+"题", ""); err == nil {
		t.Fatal("a title past the bound was accepted")
	}
	// The body keeps its byte bound, which the constant's comment says is a
	// deliberate difference: a body is a message, and GitHub's own bound on one is
	// large enough that a multi-byte body never reaches it in practice.
	if err := ValidatePRWords("t", strings.Repeat("x", MaxPRBody+1)); err == nil {
		t.Fatal("a body past the bound was accepted")
	}
}

// The session questions are the first ones whose params name something on the
// machine that the machine did not choose: a Hub reads a session's ref out of a
// listing this machine gave it and hands it back. So the shape checks here are
// about what a *listing* can produce, and the interesting case is the one that is
// deliberately absent — see TestASessionRefIsOpaqueRatherThanShaped.
func TestAgentSessionQuestionsCheckWhatTheWireCarries(t *testing.T) {
	for _, tc := range []struct {
		name   string
		params interface{ Validate() error }
		// field is the word the refusal has to name, or empty when the question
		// is one this package accepts.
		field string
	}{
		// A listing with no agent is every provider, which is the whole point of
		// the method: a phone syncing its sessions does not know which CLIs are
		// installed, and asking it to name them would be asking it to guess.
		{name: "every provider", params: AgentSessionsParams{}},
		{name: "one provider", params: AgentSessionsParams{Agent: "claude-code"}},
		{name: "a provider with the machine's own limit", params: AgentSessionsParams{Agent: "claude-code", Limit: 0}},
		{name: "a provider at the limit bound", params: AgentSessionsParams{Agent: "claude-code", Limit: MaxAgentQuery}},

		{name: "an agent over the bound", params: AgentSessionsParams{Agent: strings.Repeat("a", MaxAgentID+1)}, field: "agent"},
		{name: "a limit over the bound", params: AgentSessionsParams{Limit: MaxAgentQuery + 1}, field: "limit"},
		// Negative is not "the default": answering it with one would be answering
		// a different question than the one asked.
		{name: "a negative limit", params: AgentSessionsParams{Limit: -1}, field: "limit"},

		{name: "one page", params: AgentHistoryParams{Agent: "claude-code", Ref: "ref-1"}},
		{name: "one page with a cursor", params: AgentHistoryParams{Agent: "claude-code", Ref: "ref-1", Cursor: "c1", Limit: MaxAgentHistoryItems}},

		{name: "no agent", params: AgentHistoryParams{Ref: "ref-1"}, field: "agent"},
		{name: "no ref", params: AgentHistoryParams{Agent: "claude-code"}, field: "ref"},
		{name: "a ref over the bound", params: AgentHistoryParams{Agent: "claude-code", Ref: strings.Repeat("r", MaxSessionRef+1)}, field: "ref"},
		{name: "a cursor over the bound", params: AgentHistoryParams{Agent: "claude-code", Ref: "ref-1", Cursor: strings.Repeat("c", MaxAgentHistoryCursor+1)}, field: "cursor"},
		{name: "a page over the item bound", params: AgentHistoryParams{Agent: "claude-code", Ref: "ref-1", Limit: MaxAgentHistoryItems + 1}, field: "limit"},
		{name: "a negative page", params: AgentHistoryParams{Agent: "claude-code", Ref: "ref-1", Limit: -1}, field: "limit"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.params.Validate()
			if tc.field == "" {
				if err != nil {
					t.Fatalf("Validate() = %v, want it accepted", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("Validate() accepted %s", tc.name)
			}
			if !strings.Contains(err.Error(), tc.field) {
				t.Fatalf("Validate() = %q, want it to name %q", err, tc.field)
			}
		})
	}
}

// TestASessionRefIsOpaqueRatherThanShaped records a decision by testing the case
// that is easy to "fix" and wrong to.
//
// A ref is minted by the provider and this machine hands it out in a listing. Its
// only use on the way back is a lookup by equality, so the wire's job is to bound
// its length and nothing else. Refusing a ref for its shape would create the one
// failure worse than a broken session: a session that appears in the list and
// cannot be opened, because the listing and the read disagree about what a ref
// may contain.
//
// The cursor is the same kind of value and gets the same treatment: it is this
// machine's own token being handed back, and whether it decodes is the machine's
// answer to give, not the envelope's.
func TestASessionRefIsOpaqueRatherThanShaped(t *testing.T) {
	for _, ref := range []string{
		"a/ref/with/slashes",
		"../and/dots",
		"-and-a-leading-dash",
		"a ref with spaces",
		"ref\nwith-a-newline",
	} {
		if err := (AgentHistoryParams{Agent: "claude-code", Ref: ref}).Validate(); err != nil {
			t.Fatalf("a ref %q that a listing could have handed out was refused: %v", ref, err)
		}
	}
	if err := (AgentHistoryParams{Agent: "claude-code", Ref: "ref-1", Cursor: "not a cursor at all"}).Validate(); err != nil {
		t.Fatalf("a cursor is this machine's own token and the envelope checked its shape: %v", err)
	}
}

// TestASessionAnswerKeepsItsFieldNames pins the JSON a console and a store read.
//
// These names are the contract: the Hub writes what a Node answers straight
// through, so a renamed tag is a phone that shows sessions with no titles, or a
// transcript that never continues. The round trip is what the wire does — encode
// an answer, decode it — so a tag that changed fails here rather than on a
// device.
func TestASessionAnswerKeepsItsFieldNames(t *testing.T) {
	listed, err := Answer("q1", AgentSessionsResult{
		Sessions:  []AgentSession{{AgentID: "claude-code", ExternalRef: "ref-1", Title: "t", CreatedAt: 1}},
		Errors:    map[string]string{"codex": "no catalog"},
		Truncated: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"sessions":[{"agent_id":"claude-code","external_ref":"ref-1","title":"t","created_at":1}],` +
		`"errors":{"codex":"no catalog"},"truncated":true}`
	if string(listed.Result) != want {
		t.Fatalf("the listing encodes as\n%s\nwant\n%s", listed.Result, want)
	}

	read, err := Answer("q2", AgentHistoryResult{
		Items:      []AgentHistoryItem{{MessageID: "m1", Role: "user", Text: "hi", OccurredAt: 2, Truncated: true}},
		NextCursor: "c1",
		SourceRev:  "rev-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	want = `{"items":[{"message_id":"m1","role":"user","text":"hi","occurred_at":2,"truncated":true}],` +
		`"next_cursor":"c1","source_rev":"rev-1"}`
	if string(read.Result) != want {
		t.Fatalf("the history encodes as\n%s\nwant\n%s", read.Result, want)
	}
}
