// Extracts the CHANGELOG section for a given tag into release notes.
// Usage: node .github/scripts/release-notes.mjs <tag>   (e.g. v0.1.3)
// Prints the matching "## [x.y.z]" section; empty output = no section found.
import fs from "node:fs";

const tag = process.argv[2] ?? "";
const version = tag.replace(/^v/, "");
const text = fs.readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const re = new RegExp(
  "## \\[" + esc(version) + "\\][^\\r\\n]*\\r?\\n([\\s\\S]*?)(?=\\r?\\n## \\[|$)",
);
const m = text.match(re);
process.stdout.write(m ? m[1].trim() + "\n" : "");