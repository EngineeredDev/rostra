import { z } from "zod/v4";
import { AppError } from "../errors.js";

const jsonSchema = z.json();
export type JsonValue = z.infer<typeof jsonSchema>;

export function parseJsonValue(value: unknown): JsonValue {
  return jsonSchema.parse(value);
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AppError("invalid_request", "Canonical JSON cannot contain non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => {
      const child = value[key];
      if (child === undefined) {
        throw new AppError("invalid_request", `Canonical JSON key ${key} is undefined`);
      }
      return `${JSON.stringify(key)}:${canonicalJson(child)}`;
    })
    .join(",")}}`;
}
