package relay

import _ "embed"

// Source is the production Kin Relay Worker module bundled into the daemon so
// the Desktop GUI can deploy it without shelling out to wrangler.
//
//go:embed relay.js
var Source string
