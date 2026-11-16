#!/usr/bin/env node
// injects the api key into a build copy; the source file stays keyless
const fs = require("fs");
const path = require("path");

const root = __dirname;
const srcPath = path.join(root, "edgyanswers.user.js");
const outDir = path.join(root, "dist");
const outPath = path.join(outDir, "edgyanswers.user.js");

const key = String(process.env.HMS_API_KEY || "").trim();
if (!key) {
  console.error("HMS_API_KEY is not set — nothing to inject.");
  process.exit(1);
}
if (!/^[A-Za-z0-9._\-]{16,200}$/.test(key)) {
  console.error("HMS_API_KEY looks malformed; refusing to bake it.");
  process.exit(1);
}

const src = fs.readFileSync(srcPath, "utf8");

// refuse if the source already carries a baked key; that file must never be committed
const baked = src.match(/\bkey:\s*"([^"]+)"/);
if (baked && baked[1]) {
  console.error("source already contains a key default ('" + baked[1].slice(0, 6) + "…'). Keep the source keyless.");
  process.exit(1);
}

const needle = 'key: "",';
if (!src.includes(needle)) {
  console.error("could not find the key default (expected: " + needle + ").");
  process.exit(1);
}

const out = src.replace(needle, 'key: "' + key + '",');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, out, "utf8");

console.log("wrote " + path.relative(root, outPath) + " (" + out.length + " bytes)");
console.log("key prefix " + key.slice(0, 8) + "… injected; source untouched.");
