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

  it("reads valued options as --name value or --name=value", () => {
    const { options, flags, positional } = parseArgs(
      ["app", "--model", "haiku", "fix", "--json", "it"],
      ["--json"],
      ["--model"],
    );
    expect(Object.fromEntries(options)).toEqual({ "--model": "haiku" });
    expect([...flags]).toEqual(["--json"]);
    expect(positional).toEqual(["app", "fix", "it"]);
    expect(parseArgs(["--model=opus", "x"], [], ["--model"]).options.get("--model")).toBe("opus");
  });

  it("insists on a value for a valued option", () => {
    for (const args of [["x", "--model"], ["--model", "--json"], ["--model="]]) {
      expect(() => parseArgs(args, ["--json"], ["--model"])).toThrow(/--model needs a value/);
    }
    expect(() => parseArgs(["--mdl", "x"], [], ["--model"])).toThrow(/Known: --model <value>/);
    expect(parseArgs(["--", "--model", "x"], [], ["--model"]).positional).toEqual(["--model", "x"]);
  });
});
