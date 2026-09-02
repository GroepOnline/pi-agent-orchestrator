import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildParentContext, extractText } from "../src/context.js";

type BranchEntries = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;

describe("extractText", () => {
  it("returns an empty string for an empty array", () => {
    expect(extractText([])).toBe("");
  });

  it("extracts text from text blocks", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "text", text: " world" }
    ];
    expect(extractText(content)).toBe("Hello\n world");
  });

  it("ignores non-text blocks", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "..." } },
      { type: "text", text: " world" },
      { type: "tool_use", id: "123", name: "my_tool", input: {} }
    ];
    expect(extractText(content)).toBe("Hello\n world");
  });

  it("handles text blocks with missing text properties", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "text" }, // missing text property
      { type: "text", text: "world" }
    ];
    expect(extractText(content)).toBe("Hello\n\nworld");
  });
});

describe("buildParentContext", () => {
  function mockContext(entries: BranchEntries | undefined): ExtensionContext {
    return {
      sessionManager: {
        getBranch: () => entries
      }
    } as unknown as ExtensionContext;
  }

  it("returns empty string if entries are missing or empty", () => {
    expect(buildParentContext(mockContext([]))).toBe("");
    // getBranch might return undefined in some cases
    expect(buildParentContext(mockContext(undefined))).toBe("");
  });

  it("builds context from user and assistant messages", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "user",
          content: "User string message"
        }
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Assistant response" }]
        }
      },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "User block message" }]
        }
      }
    ];

    const context = buildParentContext(mockContext(entries));
    expect(context).toContain("# Parent Conversation Context");
    expect(context).toContain("[User]: User string message");
    expect(context).toContain("[Assistant]: Assistant response");
    expect(context).toContain("[User]: User block message");
    expect(context).toContain("# Your Task (below)");
  });

  it("ignores empty messages and includes compaction summaries", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "user",
          content: "   " // blank string
        }
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "" }] // empty text
        }
      },
      {
        type: "compaction",
        summary: "This is a summary"
      }
    ];

    const context = buildParentContext(mockContext(entries));
    expect(context).toContain("# Parent Conversation Context");
    expect(context).toContain("[Summary]: This is a summary");
    expect(context).not.toContain("[User]:");
    expect(context).not.toContain("[Assistant]:");
  });

  it("ignores tool result messages", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "user",
          content: "Visible user message"
        }
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          content: "Internal tool output"
        }
      }
    ];

    const context = buildParentContext(mockContext(entries));
    expect(context).toContain("[User]: Visible user message");
    expect(context).not.toContain("Internal tool output");
  });

  it("ignores compaction entries without summaries", () => {
    const entries = [
      {
        type: "compaction"
      }
    ];

    expect(buildParentContext(mockContext(entries))).toBe("");
  });


  it("bounds inherited context on complete entry boundaries and keeps the newest entries", () => {
    const oldJson = `\`\`\`json\n${JSON.stringify({ old: "x".repeat(220) })}\n\`\`\``;
    const recentCode = `\`\`\`ts\nfunction recent() { return 42; }\n\`\`\``;
    const entries = [
      { type: "message", message: { role: "user", content: oldJson } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Recent decision" }] } },
      { type: "message", message: { role: "user", content: recentCode } },
    ];

    const context = buildParentContext(mockContext(entries), 420);
    expect(context.length).toBeLessThanOrEqual(420);
    expect(context).toContain("complete entry boundaries preserved");
    expect(context).toContain("[Assistant]: Recent decision");
    expect(context).toContain("function recent() { return 42; }");
    expect(context).toContain("```ts");
    expect(context).not.toContain('"old"');
  });

  it("omits an oversized newest entry instead of slicing its JSON or code", () => {
    const oversized = `\`\`\`json\n${JSON.stringify({ payload: "z".repeat(4000) })}\n\`\`\``;
    const entries = [
      { type: "message", message: { role: "user", content: "Older small context" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: oversized }] } },
    ];

    const context = buildParentContext(mockContext(entries), 360);
    expect(context.length).toBeLessThanOrEqual(360);
    expect(context).toContain("complete entry boundaries preserved");
    expect(context).not.toContain("```json");
    expect(context).not.toContain('"payload"');
    expect(context).not.toContain("Older small context");
  });

  it("ignores non-message non-compaction entries", () => {
    const entries = [
      {
        type: "unknown_event",
        data: "..."
      }
    ];

    expect(buildParentContext(mockContext(entries))).toBe("");
  });
});
