import { describe, expect, it } from "vitest";
import { parseServeArgs } from "../../src/cli/main.js";

describe("serve argument parsing", () => {
  it("defaults to http when no transport flag is given", () => {
    expect(parseServeArgs([])).toEqual({ transport: "http" });
    expect(parseServeArgs(["--http"])).toEqual({ transport: "http" });
    expect(parseServeArgs(["--stdio"])).toEqual({ transport: "stdio" });
  });

  it("reads host and port overrides as name value pairs", () => {
    expect(parseServeArgs(["--http", "--host", "0.0.0.0", "--port", "9100"])).toEqual({
      transport: "http",
      host: "0.0.0.0",
      port: 9100,
    });
  });

  it("rejects unknown flags, missing values, and unusable ports", () => {
    expect(() => parseServeArgs(["--daemon"])).toThrowError(
      expect.objectContaining({ code: "invalid_command" }),
    );
    expect(() => parseServeArgs(["--port"])).toThrowError(
      expect.objectContaining({ code: "invalid_command" }),
    );
    expect(() => parseServeArgs(["--port", "not-a-number"])).toThrowError(
      expect.objectContaining({ code: "invalid_command" }),
    );
    expect(() => parseServeArgs(["--port", "70000"])).toThrowError(
      expect.objectContaining({ code: "invalid_command" }),
    );
  });
});
