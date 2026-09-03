#!/usr/bin/env node
/** Quick handoff parse check for the terminal demo (no network). */
import { parseHandoff, renderHandoffForParent } from "../dist/handoff.js";

const sample = `Explore audit complete.

\`\`\`json
{
  "type": "handoff",
  "status": "success",
  "summary": "Handoff parser accepts fenced JSON from read-only Explore agents",
  "findings": ["parseHandoff", "renderHandoffForParent"],
  "evidence": ["src/handoff.ts", "test/handoff.test.ts"]
}
\`\`\``;

const handoff = parseHandoff(sample);
console.log("parseHandoff() →", JSON.stringify(handoff, null, 2));
console.log("");
console.log("renderHandoffForParent() →");
console.log(renderHandoffForParent(handoff));
