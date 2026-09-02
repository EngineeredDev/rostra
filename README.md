![Rostra — a Roman orator addressing a civic audience from a stone podium carved with the name ROSTRA](assets/rostra-hero.png)

Rostra is a TypeScript MCP server for durable, evidence-backed deliberation and Decision CI.

It runs model work in detached worker processes. Clients can disconnect and reconnect without losing job state. The server stores jobs, decisions, evidence, outcomes, and quality metrics in one SQLite database.

## Deliberation protocols

Rostra includes six protocol presets. Each preset defines a sequence of model stages and a structured result contract.

Stage names guide the models, but Rostra does not inject full facilitator scripts or fixed attacker and defender personas.

| Protocol | Stages | Use it for | Model rounds |
| --- | --- | --- | ---: |
| `quick` | Independent analysis → ballot | Low-cost decisions that need independent views and a final vote | 2 |
| `conference` | Independent analysis → critique → revision → ballot | General decisions that benefit from peer critique and revision | 4 |
| `red_team` | Proposal → adversarial attack → defense → ballot | Stress-testing proposals against counterarguments and failure modes | 4 |
| `delphi` | Independent analysis → anonymous aggregate → revision → ballot | Reducing identity and authority effects before revision | 3, plus local aggregation |
| `premortem` | Premortem → revision → ballot | Surfacing execution risks before a final decision | 3 |
| `evidence_tribunal` | Proposal → evidence → cross-examination → adjudication → ballot | Repository decisions that require inspectable evidence | 5, plus evidence continuations |

One model round runs all committee participants concurrently. Later preset stages receive prior responses without participant identities.

The `delphi` aggregate is deterministic and local. It counts exact recommendation strings without a model or semantic clustering.

The `evidence_tribunal` protocol permits bounded file, search, tree, Git status, and Git diff operations. Rostra validates cited evidence IDs.

The `premortem` preset supplies a stage label and an analysis contract. It does not run a separate failure simulation.

Choose one committee mode for any protocol:

- `explicit`: Supply all participants.
- `adaptive`: Supply committee size and routing limits. Rostra selects configured models from calibrated metrics.

Every model response has a stage-specific schema. Rostra permits one structural repair attempt when a response does not match that schema.

The final ballot requires a two-thirds quorum. Rostra reports ballot consensus separately from semantic convergence and preserves minority rationales.

Custom protocols can change stage order, visibility, minimum completions, evidence permissions, and stopping policies. They can also add experiment-proposal stages.

## Architecture

- The MCP process validates requests and records durable jobs in SQLite.
- A detached supervisor claims queued jobs and starts one separate worker process for each job.
- Workers run configured CLI or HTTP model adapters, publish decision packets, and write Markdown transcripts.
- Stdio and Streamable HTTP expose the same tools, resources, storage, and worker pool.

## Requirements

- Node.js 24 or newer
- One configured model adapter

CLI adapters also require their matching executable. HTTP adapters require access to their configured endpoint.

Git and pnpm 10.11.0 are only required for a source install.

## Install from source

The public npm release is pending. Use the source install until the package is available:

```bash
git clone https://github.com/EngineeredDev/rostra.git
cd rostra
corepack enable
pnpm install --frozen-lockfile
pnpm build
node dist/cli/main.js init
```

The `init` command creates the user configuration and data directory. It also downloads and verifies the pinned MiniLM model when required.

Edit `~/.config/rostra/config.yaml`. Enable only the adapters and models that you use.

The same command is safe to run after an upgrade. It never replaces an existing configuration.

Rostra reads configuration from the first available path:

1. `ROSTRA_CONFIG`
2. `$XDG_CONFIG_HOME/rostra/config.yaml`
3. `~/.config/rostra/config.yaml`
4. The packaged `config.example.yaml`

Rostra writes `rostra.sqlite`, transcripts, and model files to the data directory. It selects this directory in the following order:

1. `ROSTRA_DATA_HOME`
2. `$XDG_DATA_HOME/rostra`
3. `~/.local/share/rostra`

### Configuration

The version 2 YAML schema rejects unknown fields. Use `config.example.yaml` as a starter configuration.

Supported CLI adapters are `claude`, `codex`, `droid`, `gemini`, `llamacpp`, and `omp`. Supported HTTP adapters are `ollama`, `lmstudio`, `openrouter`, `nebius`, and `openai`.

The model registry controls the model IDs, reasoning efforts, capabilities, provider families, costs, and latency estimates available for routing.

The default `local_minilm` similarity provider uses a pinned MiniLM model. The `openai_compatible` provider supports a remote embedding endpoint instead.

## Configure an MCP client

Use the absolute source path until the npm package is public:

```json
{
  "mcpServers": {
    "rostra": {
      "command": "node",
      "args": ["/absolute/path/to/rostra/dist/cli/main.js"]
    }
  }
}
```

After npm publication, clients can use the exact package version:

```json
{
  "mcpServers": {
    "rostra": {
      "command": "npx",
      "args": ["--yes", "@engineereddev/rostra@0.1.0-beta.1"]
    }
  }
}
```

The server uses stdio transport by default. It writes protocol messages only to standard output.

### HTTP transport

`rostra serve --http` serves the same tool surface over Streamable HTTP at `/mcp`:

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
docker run -p 127.0.0.1:8787:8787 rostra serve --http --host 0.0.0.0
```

`rostra serve --stdio` is the explicit form of the default; bare `rostra` still means
stdio.

Both transports keep the build identity captured at startup. Rebuilding or editing the
configuration underneath a running server makes the next dispatch fail with
`stale_server_build`; restart the server.

## Manage deliberations

Submit a durable job with `start_deliberation`. Only valid ballots from the final completed ballot stage affect consensus.

Use these tools to manage jobs:

- `start_deliberation`
- `list_deliberations`
- `get_deliberation`
- `tail_deliberation`
- `cancel_deliberation`
- `resume_deliberation`

A recovered job can enter `recovery_required` after an uncertain external attempt. Call `resume_deliberation` with `retry` or `cancel` to resolve it.

### Deliberations as resources

Every job is also readable as a resource. Clients do not have to poll a tool:

- `rostra://deliberations/{job_id}` returns what `get_deliberation` returns.
- `rostra://deliberations/{job_id}/events` returns the first 500 events and a `next_seq` cursor.

Use `tail_deliberation` when you need a custom cursor, limit, or blocking wait.

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

Experiment proposals are inert records. Rostra does not run their commands.

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

## Command-line utilities

The CLI also initializes user files and manages jobs and model files:

```bash
node dist/cli/main.js init
node dist/cli/main.js jobs list
node dist/cli/main.js jobs cancel <job-id>
node dist/cli/main.js models fetch
```

`jobs list` returns the 100 most recent jobs as JSON. `jobs cancel` requests idempotent cancellation for one job.

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
docker build -t rostra .
```

Run the MCP server with a mounted configuration and data directory:

```bash
docker run --rm -i \
  -e ROSTRA_CONFIG=/config/config.yaml \
  -v "$PWD/config.yaml:/config/config.yaml:ro" \
  -v rostra-data:/home/node/.local/share/rostra \
  rostra
```

Run the HTTP transport instead, published on the host's loopback address:

```bash
docker run --rm -p 127.0.0.1:8787:8787 \
  -e ROSTRA_CONFIG=/config/config.yaml \
  -v "$PWD/config.yaml:/config/config.yaml:ro" \
  -v rostra-data:/home/node/.local/share/rostra \
  rostra serve --http --host 0.0.0.0
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
