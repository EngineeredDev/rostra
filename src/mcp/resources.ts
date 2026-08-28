import {
  ResourceTemplate,
  type McpServer,
  type ReadResourceResult,
  type Variables,
} from "@modelcontextprotocol/server";
import type { JobStore } from "../jobs/store.js";
import { parseJsonValue } from "../utils/canonical-json.js";
import { DELIBERATION_URI_PREFIX, jobProjection, type JsonObject } from "./projection.js";

function jobIdOf(variables: Variables): string {
  const value = variables.job_id;
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function jsonResource(uri: URL, payload: JsonObject): ReadResourceResult {
  return {
    contents: [
      { uri: uri.href, mimeType: "application/json", text: JSON.stringify(payload, null, 2) },
    ],
  };
}

/**
 * The set of jobs is unbounded, so both are templates: they appear in `resources/templates/list`
 * rather than `resources/list`. The more specific template registers first so a `/events` URI
 * cannot be captured by the bare job template.
 */
export function registerDeliberationResources(server: McpServer, store: JobStore): void {
  server.registerResource(
    "deliberation-events",
    new ResourceTemplate(`${DELIBERATION_URI_PREFIX}{job_id}/events`, { list: undefined }),
    {
      title: "Deliberation events",
      description: "Ordered job events, the payload tail_deliberation returns",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const jobId = jobIdOf(variables);
      const events = store.events(jobId, 0, 500);
      return jsonResource(uri, {
        job_id: jobId,
        events: parseJsonValue(JSON.parse(JSON.stringify(events))),
        next_seq: events.at(-1)?.seq ?? 0,
      });
    },
  );

  server.registerResource(
    "deliberation",
    new ResourceTemplate(`${DELIBERATION_URI_PREFIX}{job_id}`, { list: undefined }),
    {
      title: "Deliberation",
      description: "One durable deliberation job, the payload get_deliberation returns",
      mimeType: "application/json",
    },
    (uri, variables) => jsonResource(uri, jobProjection(store.get(jobIdOf(variables)), false, store)),
  );
}
