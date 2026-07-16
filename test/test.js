#!/usr/bin/env node
// End-to-end test: for each case, nifc emits C from a real post-hexer .c.nif,
// gcc compiles it to a native binary, we run it, and assert the printed result.
// The .c.nif inputs in examples/ were produced by nimony's own frontend+hexer.
"use strict";
const cp = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const NIFC = path.join(ROOT, "bin", "nifc");
const EX = path.join(ROOT, "examples");

// [file, entry, args, expected-stdout]
const CASES = [
  ["fib.c.nif",     "fib",      [10],       "55"],
  ["fib.c.nif",     "fib",      [20],       "6765"],
  ["fib.c.nif",     "fib",      [30],       "832040"],
  ["fib.c.nif",     "sumTo",    [100],      "5050"],
  ["fib.c.nif",     "sumTo",    [1000],     "500500"],
  ["compute.c.nif", "gcd",      [48, 36],   "12"],
  ["compute.c.nif", "gcd",      [1071, 462],"21"],
  ["compute.c.nif", "isPrime",  [97],       "1"],
  ["compute.c.nif", "isPrime",  [91],       "0"],
  ["compute.c.nif", "collatz",  [27],       "111"],
  ["compute.c.nif", "popcount", [255],      "8"],
  ["compute.c.nif", "popcount", [0],        "0"],
  ["mathf.c.nif",   "power",    ["2.0", 10],"1024"],
  ["mathf.c.nif",   "classify", [0],        "100"],
  ["mathf.c.nif",   "classify", [2],        "200"],
  ["mathf.c.nif",   "classify", [15],       "300"],
  ["mathf.c.nif",   "classify", [7],        "999"],
  ["mathf.c.nif",   "absf",     ["-3.5"],   "3.5"],
];

// whole-module builds that must compile + link + run (exit 0)
const MODULE_BUILDS = ["fib.c.nif", "compute.c.nif", "mathf.c.nif"];

function run(file, entry, args) {
  const argv = ["exec", path.join(EX, file), "--entry", entry];
  for (const a of args) argv.push("--arg", String(a));
  const r = cp.spawnSync("node", [NIFC, ...argv], { encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || "").trim() || "exec failed");
  return r.stdout.trim();
}

let pass = 0, fail = 0;
for (const [file, entry, args, want] of CASES) {
  const label = `${entry}(${args.join(",")})`.padEnd(22);
  try {
    const got = run(file, entry, args);
    if (got === want) { console.log(`  ok   ${label} = ${got}`); pass++; }
    else { console.log(`  FAIL ${label} => ${got}  (want ${want})`); fail++; }
  } catch (e) { console.log(`  FAIL ${label} => ${e.message}`); fail++; }
}
for (const file of MODULE_BUILDS) {
  const r = cp.spawnSync("node", [NIFC, "run", path.join(EX, file)], { encoding: "utf8" });
  if (r.status === 0) { console.log(`  ok   module build+run ${file}`); pass++; }
  else { console.log(`  FAIL module build+run ${file}: ${(r.stderr||"").trim()}`); fail++; }
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
