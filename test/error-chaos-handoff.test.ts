import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHandoff } from '../src/handoff.js';

describe('Handoff - Error Chaos & Resilience', () => {
  let warnSpy: any;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('should gracefully handle corrupted handoff JSON', () => {
    const corruptedPayload = 'invalid json { broken';
    const result = parseHandoff(corruptedPayload);
    expect(result).toBeNull();
  });

  it('should handle missing required fields in handoff', () => {
    // Missing type, status, summary, findings
    const incomplete = `
\`\`\`json
{
  "type": "handoff",
  "status": "success"
}
\`\`\``;
    const result = parseHandoff(incomplete);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Missing or invalid fields')
    );
  });

  it('should handle invalid status values', () => {
    const invalidStatus = `
\`\`\`json
{
  "type": "handoff",
  "status": "awesome",
  "summary": "This is a summary",
  "findings": ["Finding 1"]
}
\`\`\``;
    const result = parseHandoff(invalidStatus);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('status')
    );
  });

  it('should survive extremely large JSON payloads exceeding MAX_JSON_SIZE', () => {
    // MAX_JSON_SIZE is 1MB. Let's construct a payload larger than 1MB.
    const largeSummary = 'a'.repeat(1024 * 1024 + 10);
    const largePayload = `
\`\`\`json
{
  "type": "handoff",
  "status": "success",
  "summary": "${largeSummary}",
  "findings": ["Finding 1"]
}
\`\`\``;
    const result = parseHandoff(largePayload);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('exceeds maximum')
    );
  });

  it('should survive excessive key count (DOS prevention)', () => {
    // MAX_JSON_KEYS is 1000. Let's create an object with 1005 keys inside findings
    const keysObj: Record<string, string> = {};
    for (let i = 0; i < 1005; i++) {
      keysObj[`key${i}`] = 'val';
    }
    const excessiveKeysPayload = `
\`\`\`json
{
  "type": "handoff",
  "status": "success",
  "summary": "Good summary",
  "findings": ["Finding 1"],
  "excessive": ${JSON.stringify(keysObj)}
}
\`\`\``;
    const result = parseHandoff(excessiveKeysPayload);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('JSON key count exceeds maximum')
    );
  });

  it('should handle extremely long summaries exceeding MAX_SUMMARY_LENGTH', () => {
    // MAX_SUMMARY_LENGTH is 10000. Let's create a summary with 10005 chars.
    const longSummary = 's'.repeat(10005);
    const longSummaryPayload = `
\`\`\`json
{
  "type": "handoff",
  "status": "success",
  "summary": "${longSummary}",
  "findings": ["Finding 1"]
}
\`\`\``;
    const result = parseHandoff(longSummaryPayload);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('summary (too long)')
    );
  });

  it('should handle too many findings exceeding MAX_FINDINGS_COUNT', () => {
    // MAX_FINDINGS_COUNT is 100. Let's create 105 findings.
    const findings = Array.from({ length: 105 }, (_, i) => `finding ${i}`);
    const tooManyFindingsPayload = `
\`\`\`json
{
  "type": "handoff",
  "status": "success",
  "summary": "Summary",
  "findings": ${JSON.stringify(findings)}
}
\`\`\``;
    const result = parseHandoff(tooManyFindingsPayload);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('findings (too many')
    );
  });

  it('should gracefully truncate strings exceeding MAX_STRING_LENGTH', () => {
    // MAX_STRING_LENGTH is 50000. A string of 60000 chars should be truncated to 50000.
    // Note that the overall JSON size must still be less than 1MB.
    const longString = 'x'.repeat(60000);
    const payload = `
\`\`\`json
{
  "type": "handoff",
  "status": "success",
  "summary": "A valid summary",
  "findings": ["Finding 1"],
  "evidence": ["${longString}"]
}
\`\`\``;
    const result = parseHandoff(payload);
    expect(result).not.toBeNull();
    expect(result!.evidence).toBeDefined();
    expect(result!.evidence![0].length).toBe(50000);
    expect(result!.evidence![0]).toBe(longString.slice(0, 50000));
  });

  it('should survive deeply nested JSON structures (DOS prevention)', () => {
    // Deep nesting is caught by the depth limit before the key count limit can
    // fire: each level adds exactly one key, so depth 20 trips long before the
    // 1000-key ceiling. { a: { b: { c: ... } } } with 1005 levels.
    let nestedJson = '"value"';
    for (let i = 0; i < 1005; i++) {
      nestedJson = `{"level${i}":${nestedJson}}`;
    }
    const payload = `
\`\`\`json
{
  "type": "handoff",
  "status": "success",
  "summary": "Good summary",
  "findings": ["Finding 1"],
  "nested": ${nestedJson}
}
\`\`\``;
    const result = parseHandoff(payload);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('JSON depth exceeds maximum')
    );
  });

  it('should handle repeated parses without side effects', () => {
    const rawPayload = `
\`\`\`json
{
  "type": "handoff",
  "status": "success",
  "summary": "Fast summary",
  "findings": ["Finding 1"]
}
\`\`\``;
    const results = Array.from({ length: 100 }, () => parseHandoff(rawPayload));

    expect(results).toHaveLength(100);
    results.forEach((res) => {
      expect(res).not.toBeNull();
      expect(res!.type).toBe('handoff');
      expect(res!.status).toBe('success');
      expect(res!.summary).toBe('Fast summary');
    });
  });
});
