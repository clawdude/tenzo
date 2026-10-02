import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.ts";

describe("parseArgs", () => {
  it("separates known flags from positionals", () => {
    const { flags, positional } = parseArgs(["thr_x", "--force"], ["--force"]);
    expect([...flags]).toEqual(["--force"]);
    expect(positional).toEqual(["thr_x"]);
  });

  it("rejects unknown flags instead of dropping them", () => {
    expect(() => parseArgs(["thr_x", "--froce"], ["--force"])).toThrow(
      /Unknown option "--froce". Known: --force/,
    );
    expect(() => parseArgs(["app", "--force", "stuff"])).toThrow(/Unknown option "--force"/);
  });

  it("treats everything after a bare -- as positional", () => {
    const { flags, positional } = parseArgs(["app", "--", "--force", "stuff", "--"], ["--force"]);
    expect(flags.size).toBe(0);
    expect(positional).toEqual(["app", "--force", "stuff", "--"]);
  });

  it("leaves single-dash words alone", () => {
    expect(parseArgs(["app", "-", "fix", "-x"]).positional).toEqual(["app", "-", "fix", "-x"]);
  });
});
