# Claude API Server (Sandbox)

Run this on the machine that has Claude Code installed (e.g. your Mac).
The Pi will forward queries here via HTTP.

## Setup

```bash
npm install
node server-fast.js
```

Runs on port 3333 by default. Set `CLAUDE_API_URL=http://<this-machine-ip>:3333` in the Pi's .env.

## Security

- Only exposes WebSearch and WebFetch tools
- MCP servers disabled via no-mcp.json
- Runs from this clean directory so Claude has no filesystem context
- Edit CLAUDE.md to customize personality, rules, and skills
