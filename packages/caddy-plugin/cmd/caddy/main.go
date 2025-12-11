package main

import (
	caddycmd "github.com/caddyserver/caddy/v2/cmd"

	// Import standard modules
	_ "github.com/caddyserver/caddy/v2/modules/standard"

	// Import our durable streams module
	_ "github.com/electric-sql/caddy-durable-streams"
)

func main() {
	caddycmd.Main()
}
