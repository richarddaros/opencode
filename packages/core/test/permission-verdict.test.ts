import { describe, expect, it } from "bun:test"
import { buildPrompt, capReason, parseVerdict, summarize } from "../src/permission/verdict.js"

describe("permission verdict parser", () => {
  it("parses ALLOW verdicts", () => {
    expect(parseVerdict("ALLOW")).toEqual({ verdict: "allow" })
    expect(parseVerdict("ALLOW ")).toEqual({ verdict: "allow" })
    expect(parseVerdict("allow")).toEqual({ verdict: "allow" })
    expect(parseVerdict("allow \nwith trailing context")).toEqual({ verdict: "allow" })
  })

  it("parses DENY verdicts with reasons", () => {
    expect(parseVerdict("DENY destructive command")).toEqual({
      verdict: "deny",
      reason: "destructive command",
    })
    expect(parseVerdict("deny prints secrets")).toEqual({
      verdict: "deny",
      reason: "prints secrets",
    })
  })

  it("parses UNCERTAIN verdicts with reasons", () => {
    expect(parseVerdict("UNCERTAIN outside project")).toEqual({
      verdict: "uncertain",
      reason: "outside project",
    })
  })

  it("ignores <think> blocks and parses the actual verdict", () => {
    const output = "<think>Analyzing command safety...\nSeems like a read operation.</think>\nALLOW"
    expect(parseVerdict(output)).toEqual({ verdict: "allow" })
  })

  it("rejects invalid outputs or bare DENY/UNCERTAIN without reasons", () => {
    expect(parseVerdict("")).toBeUndefined()
    expect(parseVerdict("I think this is safe")).toBeUndefined()
    expect(parseVerdict("DENY")).toBeUndefined()
    expect(parseVerdict("UNCERTAIN")).toBeUndefined()
  })

  it("caps reasons exceeding 200 characters", () => {
    const longReason = "a".repeat(250)
    const capped = capReason(longReason)
    expect(capped.length).toBe(200)
  })
})

describe("permission prompt builder", () => {
  it("builds prompt with fences and nonces", () => {
    const prompt = buildPrompt(
      {
        permission: "bash",
        patterns: ["ls -la", "cat package.json"],
        metadata: { command: "ls -la" },
      },
      "User asked to inspect the directory",
    )

    expect(prompt.truncated).toBe(false)
    expect(prompt.text).toContain("<<<REQUEST ")
    expect(prompt.text).toContain("REQUEST ")
    expect(prompt.text).toContain("<<<SUMMARY ")
    expect(prompt.text).toContain("SUMMARY ")
    expect(prompt.text).toContain("ls -la")
    expect(prompt.text).toContain("User asked to inspect the directory")
  })

  it("detects payload truncation when pattern or metadata limits are exceeded", () => {
    const hugePattern = "x".repeat(3000)
    const prompt = buildPrompt({
      permission: "bash",
      patterns: [hugePattern],
      metadata: {},
    })

    expect(prompt.truncated).toBe(true)
  })
})

describe("permission metadata summarizer", () => {
  it("truncates long metadata values and serializes objects", () => {
    const summary = summarize({
      command: "npm test",
      longField: "y".repeat(600),
      nested: { foo: "bar" },
    })

    expect(summary?.command).toBe("npm test")
    expect(summary?.nested).toBe('{"foo":"bar"}')
    expect(typeof summary?.longField).toBe("string")
    expect((summary?.longField as string).endsWith("…")).toBe(true)
  })
})
