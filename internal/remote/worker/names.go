package worker

import "strings"

// Shape checks for the two names a dispatch carries that a Node turns into
// paths on its own disk.
//
// They live in the protocol package because they are properties of the wire
// contract — what a Hub may put in `Attachment.Stored` and `Dispatch.TaskID` —
// and because both ends have to agree on them: the Hub refuses to send a name
// the Node would refuse to write. They import nothing, so the protocol package
// stays the leaf ADR 0025 D5 requires.

// MaxAttachmentName bounds a stored upload name. Uploads are named
// `<random>.<ext>`; the bound is a ceiling on what any name may be, not a
// prediction of its length.
const MaxAttachmentName = 128

// SafeAttachmentName reports whether a stored upload name can serve as one path
// element.
//
// The name crosses the wire, and the machine that receives it joins it to a
// directory and writes there. That machine is entitled to assume nothing: one
// element, no traversal, no control characters. The check is about shape, not
// provenance — what a file contains is the Hub's business; what it may be
// called is the Node's.
func SafeAttachmentName(name string) bool {
	if name == "" || len(name) > MaxAttachmentName || name == "." || name == ".." {
		return false
	}
	if strings.ContainsAny(name, `/\`) || strings.Contains(name, "..") {
		return false
	}
	if strings.ContainsAny(name, "\x00\n\r") {
		return false
	}
	return true
}

// SafeTaskID reports whether a task id can serve as a directory name.
//
// It is stricter than SafeAttachmentName because the id becomes a directory
// rather than a file: a leading dot would make it hidden, and a colon or space
// would make it something other tools refuse to read.
func SafeTaskID(id string) bool {
	if id == "" || len(id) > MaxTaskID || id == "." || id == ".." {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-', r == '_', r == '.':
		default:
			return false
		}
	}
	return true
}
