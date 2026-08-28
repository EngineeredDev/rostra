<p align="center">
  <img src="assets/ai-counsel.png" alt="AI Counsel" width="400">
</p>

# AI Counsel

AI Counsel is a TypeScript MCP server for durable, evidence-backed deliberation and Decision CI.

It runs model work in detached worker processes. Clients can disconnect and reconnect without losing job state. The server stores jobs, decisions, evidence, outcomes, and quality metrics in one SQLite database.

## Requirements

- Node.js 24 or newer
- pnpm 10.11.0
- Git
- One configured model adapter

CLI adapters also require their matching executable. HTTP adapters require access to their configured endpoint.

## Install from source

```bash
git clone https://github.com/stoopkidddd/ai-counsel.git
cd ai-counsel
corepack enable
pnpm install --frozen-lockfile
pnpm build
mkdir -p ~/.config/ai-counsel
cp config.example.yaml ~/.config/ai-counsel/config.yaml
pnpm models:fetch
```

Edit `~/.config/ai-counsel/config.yaml`. Enable only the adapters and models that you use.

AI Counsel reads configuration from the first available path:

1. `AI_COUNSEL_CONFIG`
2. `$XDG_CONFIG_HOME/ai-counsel/config.yaml`
3. `~/.config/ai-counsel/config.yaml`
4. The packaged `config.example.yaml`

AI Counsel writes `ai-counsel.sqlite`, transcripts, and model files to the data directory. Set `AI_COUNSEL_DATA_HOME` to change this directory. The default is `~/.local/share/ai-counsel`.

## Configure an MCP client

Use an absolute repository path in the client configuration:

```json
{
  "mcpServers": {
    "ai-counsel": {
      "command": "node",
      "args": ["/absolute/path/to/ai-counsel/dist/cli/main.js"],
      "env": {
        "AI_COUNSEL_CONFIG": "/absolute/path/to/config.yaml"
      }
    }
  }
}
```

The server uses stdio transport by default. It writes protocol messages only to standard output.

### HTTP transport

`ai-counsel serve --http` serves the same tool surface over Streamable HTTP at `/mcp`:

```bash
node dist/cli/main.js serve --http --port 8787
```

Point a client at `http://127.0.0.1:8787/mcp`. One HTTP process serves every client, so the
embedding model is loaded once instead of once per stdio client.

The endpoint has no authentication. It binds `127.0.0.1` and rejects any request whose `Host`
or `Origin` header is not loopback. Do not expose it to a network you do not control. Configure
the bind address, port, subscription cap, and keep-alive interval under `http:` in `config.yaml`;
`--host` and `--port` override them.

`--host 0.0.0.0` prints a warning and is only meant for containers, where the loopback bind is
unreachable through `-p`. Publish it on the host's loopback address:

```bash
docker run -p 127.0.0.1:8787:8787 ai-counsel serve --http --host 0.0.0.0
```

`ai-counsel serve --stdio` is the explicit form of the default; bare `ai-counsel` still means
stdio.

Both transports keep the build identity captured at startup. Rebuilding or editing the
configuration underneath a running server makes the next dispatch fail with
`stale_server_build`; restart the server.

## Durable deliberation

Submit a job with `start_deliberation`. Choose one committee mode:

- `explicit`: supply all participants.
- `adaptive`: supply committee size and routing limits. AI Counsel selects configured models from calibrated metrics.

The shipped protocols are:

- `quick`
- `conference`
- `red_team`
- `delphi`
- `premortem`
- `evidence_tribunal`

The result separates ballot consensus from semantic convergence. Only valid ballots from the final completed ballot stage affect consensus.

Use these tools to manage jobs:

- `start_deliberation`
- `list_deliberations`
- `get_deliberation`
- `tail_deliberation`
- `cancel_deliberation`
- `resume_deliberation`

A recovered job can enter `recovery_required` after an uncertain external attempt. Call `resume_deliberation` with `retry` or `cancel` to resolve it.

### Deliberations as resources

Every job is also readable as a resource, with no polling:

- `counsel://deliberations/{job_id}` returns what `get_deliberation` returns.
- `counsel://deliberations/{job_id}/events` returns what `tail_deliberation` returns.

Both are URI templates, so they appear under `resources/templates/list` rather than
`resources/list`. The server advertises `resources.subscribe`, and a client on the 2026-07-28
protocol can subscribe to a job's URIs and receive `notifications/resources/updated` as the job
moves. Job transitions happen in detached worker processes, so the server discovers them by
polling the database every `jobs.poll_interval_ms`; a subscriber sees a change one interval late.

Blocking calls also report progress. When `get_deliberation(wait_for_terminal)` or
`tail_deliberation(wait_for_change)` is called with a progress token, each newly recorded job
event is sent as `notifications/progress`, keyed by the event sequence number.

## Decisions and outcomes

Each completed job publishes an immutable decision packet. The packet includes claims, evidence provenance, predictions, ballots, minority reports, and experiment proposals.

Experiment proposals are inert records. AI Counsel does not run their commands.

Decision data is scoped to the canonical Git workspace. Use these MCP tools:

- `query_decisions`
- `list_stale_decisions`
- `record_decision_outcome`
- `review_decision_change`

`record_decision_outcome` appends an observed outcome. It never changes an earlier outcome. Resolved prediction labels update model calibration metrics.

## Decision CI

Review a Git range from the command line:

```bash
node dist/cli/main.js decision review \
  --working-directory /path/to/repository \
  --base origin/main \
  --head HEAD \
  --format json \
  --fail-on warning
```

`--format` accepts `text`, `json`, or `sarif`. `--fail-on` accepts `error`, `warning`, or `none`.

The command returns these exit codes:

- `0`: no finding meets the threshold.
- `1`: invalid input or runtime failure.
- `2`: at least one finding meets the threshold.

Decision CI reports stale evidence, changed assumptions, conflicting decisions, superseded precedents, and outcome regressions. It does not modify the repository.

## Model and quality tools

- `list_models` lists enabled configured models.
- `set_session_models` changes adapter defaults for the whole server process. Over HTTP one
  process serves every client, so these overrides are shared rather than per-client.
- `get_quality_metrics` returns attempts, ballots, failures, latency, cost, and prediction calibration.

Adaptive routing uses Laplace-smoothed success rates and Brier calibration. It also enforces provider-family, cost, and latency constraints.

## Evidence boundary

Built-in evidence tools confine file and Git access to the canonical workspace. They reject traversal, symlink escapes, and unsupported Git arguments.

CLI model adapters run as unrestricted host processes. Their decision packets use `host_unrestricted` as the execution isolation value. Set `execution.allow_host_tools: true` to permit them.

## Docker

Build the image:

```bash
docker build -t ai-counsel .
```

Run the MCP server with a mounted configuration and data directory:

```bash
docker run --rm -i \
  -e AI_COUNSEL_CONFIG=/config/config.yaml \
  -v "$PWD/config.yaml:/config/config.yaml:ro" \
  -v ai-counsel-data:/home/node/.local/share/ai-counsel \
  ai-counsel
```

Run the HTTP transport instead, published on the host's loopback address:

```bash
docker run --rm -p 127.0.0.1:8787:8787 \
  -e AI_COUNSEL_CONFIG=/config/config.yaml \
  -v "$PWD/config.yaml:/config/config.yaml:ro" \
  -v ai-counsel-data:/home/node/.local/share/ai-counsel \
  ai-counsel serve --http --host 0.0.0.0
```

The container must bind `0.0.0.0` to be reachable through `-p`, which is why the published port
is pinned to `127.0.0.1`. The endpoint is unauthenticated.

The image includes Git. It does not include third-party model CLIs.

## Development

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm generate:schemas
```

Generated MCP input and output schemas are in `docs/generated/tool-schemas.json`.

## Release boundary

The TypeScript release does not read Python configuration or Python-era SQLite databases. Use a new version 2 configuration and a new data directory.

## License

MIT
