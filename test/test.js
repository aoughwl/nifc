#!/usr/bin/env node
// End-to-end test: for each case, aowlc emits C from a real post-hexer .c.nif,
// gcc compiles it to a native binary, we run it, and assert the printed result.
// The .c.nif inputs in examples/ were produced by nimony's own frontend+hexer.
"use strict";
const cp = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const AOWLC = path.join(ROOT, "bin", "aowlc");
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
  const r = cp.spawnSync("node", [AOWLC, ...argv], { encoding: "utf8" });
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
  const r = cp.spawnSync("node", [AOWLC, "run", path.join(EX, file)], { encoding: "utf8" });
  if (r.status === 0) { console.log(`  ok   module build+run ${file}`); pass++; }
  else { console.log(`  FAIL module build+run ${file}: ${(r.stderr||"").trim()}`); fail++; }
}

// Whole real nimony `system` module: emit C and require it to compile clean.
// This is the runtime-provider path — the actual lib/std/system/* sources
// (strings/seqs/ARC/alloc/dynlib/panics) through nimony's frontend+hexer, then
// aowlc → C. It exercises importc + C headers + varargs, and guards against a
// regression in that whole class. Skipped (not failed) if no C compiler.
{
  const fs = require("fs");
  const sys = path.join(EX, "system.c.nif");
  const CC = process.env.CC || "gcc";
  const haveCC = cp.spawnSync(CC, ["--version"], { encoding: "utf8" }).status === 0;
  if (!haveCC || !fs.existsSync(sys)) {
    console.log(`  skip system.c.nif emit+compile (no ${CC} or fixture)`);
  } else {
    const em = cp.spawnSync("node", [AOWLC, "emit", sys], { encoding: "utf8" });
    if (em.status !== 0) { console.log(`  FAIL system.c.nif emit: ${(em.stderr||"").trim()}`); fail++; }
    else {
      const gcc = cp.spawnSync(CC, ["-std=c11", "-fsyntax-only", "-w", "-xc", "-"],
        { input: em.stdout, encoding: "utf8" });
      if (gcc.status === 0) { console.log("  ok   system.c.nif emit + compile (real system module)"); pass++; }
      else { console.log(`  FAIL system.c.nif compile:\n${(gcc.stderr||"").split("\n").slice(0,6).join("\n")}`); fail++; }
    }
  }
}

// Whole-program LINK: a real `echo` program + the real compiled system/syncio
// runtime, all as separate .c.nif modules, linked into one native binary and
// run. Proves cross-module content-addressed names resolve (own `name.0.` vs
// referenced `name.0.<hash>`) and that the genuinely-compiled runtime works —
// no hand-written runtime. Modules must keep their hash basenames.
{
  const fs = require("fs");
  const dir = path.join(EX, "prog_echo");
  const CC = process.env.CC || "gcc";
  const haveCC = cp.spawnSync(CC, ["--version"], { encoding: "utf8" }).status === 0;
  if (!haveCC || !fs.existsSync(dir)) {
    console.log("  skip whole-program link (no cc or fixtures)");
  } else {
    // runtime modules first, the module with `main` last
    const mods = fs.readdirSync(dir).filter((f) => f.endsWith(".c.nif")).map((f) => path.join(dir, f));
    const main = mods.find((f) => fs.readFileSync(f, "utf8").includes('exportc "main"'));
    const ordered = [...mods.filter((f) => f !== main), main];
    const r = cp.spawnSync("node", [AOWLC, "link-run", ...ordered, "--no-stubs"], { encoding: "utf8" });
    const got = (r.stdout || "").trim();
    if (r.status === 0 && got === "hi") { console.log("  ok   whole-program link+run echo (compiled runtime) = hi"); pass++; }
    else { console.log(`  FAIL whole-program link+run => "${got}" (status ${r.status}) ${(r.stderr||"").split("\n")[0]}`); fail++; }
  }
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
