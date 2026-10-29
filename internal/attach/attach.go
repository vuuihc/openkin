// Package attach reads the "Attached …:" block the composer appends to a
// prompt.
//
// The block is a text convention rather than a field, so it is the one part of
// an attachment that survives every path a prompt takes: into a task row, into
// a dispatch frame, into an agent's own arguments. Two very different readers
// depend on it — the adapter that opens the files here, and the Hub that has to
// know which files a machine without them will need sent. They have to agree on
// what the block says, which is why the parser lives between them instead of in
// either one.
package attach

import (
	"regexp"
	"strings"
)

// blockRe matches a whole block, including the optional newline before it, so
// the surrounding text can be put back together without a blank line where the
// block was.
var blockRe = regexp.MustCompile(`(?is)(?:^|\n)Attached (?:image|file|files):\n((?:[ \t]*-[ \t].+\n?)*)`)

// lineRe matches one `- label: path` line. The path ends at the last space, so
// a path with spaces in it does not parse — the composer writes paths without
// quoting, and guessing where a space belongs would rewrite the wrong text.
var lineRe = regexp.MustCompile(`(?m)^[ \t]*-[ \t]+(.+?):\s+(\S+)\s*$`)

// Entry is one file a prompt names: the label a person sees and the path an
// agent would open.
type Entry struct {
	Label string
	Path  string
}

// Split peels the attachment block from a prompt. It returns the text without
// the block — what the person actually wrote — and the files the block names,
// in the order they appear. A prompt with no block is returned unchanged with
// no entries, so a caller need not special-case the common case.
//
// Only lines that read as `- label: path` belong to the block. A bullet that
// does not is left in the text rather than dropped with the rest, because it is
// something a reader is meant to see: the most important case is the note a
// machine writes in place of a file it could not bring over, and a note removed
// together with the block would tell the model nothing about the file it
// cannot open.
func Split(prompt string) (text string, entries []Entry) {
	loc := blockRe.FindStringSubmatchIndex(prompt)
	if loc == nil {
		return prompt, nil
	}
	// loc[0]:loc[1] covers the whole match, including the newline before the
	// header; the pieces either side are rejoined with the paragraph break the
	// block was separated by.
	var parts []string
	for _, piece := range []string{prompt[:loc[0]], peel(prompt[loc[2]:loc[3]], &entries), prompt[loc[1]:]} {
		if piece = strings.TrimSpace(piece); piece != "" {
			parts = append(parts, piece)
		}
	}
	return strings.Join(parts, "\n\n"), entries
}

// peel takes the attachment lines out of a block body and returns what is left
// of it, line by line rather than as one match: a block is a list, and one line
// in it that is not a file does not make the others stop being files.
func peel(block string, entries *[]Entry) string {
	var kept strings.Builder
	for _, line := range strings.SplitAfter(block, "\n") {
		if m := lineRe.FindStringSubmatch(line); m != nil {
			if path := strings.TrimSpace(m[2]); path != "" {
				*entries = append(*entries, Entry{Label: strings.TrimSpace(m[1]), Path: path})
				continue
			}
		}
		kept.WriteString(line)
	}
	return kept.String()
}
