#
# aowlc_parity — a minimal driver over lengc's REAL C backend (codegen.generateCode),
# vendored from nimony/src/lengc so output is byte-identical to `nimony c` (lengc).
#
# Usage: aowlc_parity <in.c.nif> <out.c> [--main]
#
# It replicates the setup that lengc.nim's handleCmdLine / generateBackend perform
# for the C path only: State(config: ConfigRef(), bits: sizeof(int)*8), ccGcc,
# appConsole, backendC, nifcacheDir = dir(out). The main module is emitted with
# {gfMainModule}, others with {}.

import std / [os, syncio]
import codegen
import noptions

proc main =
  var args: seq[string] = @[]
  var isMain = false
  for i in 1 .. paramCount():
    let a = paramStr(i)
    if a == "--main" or a == "--isMain":
      isMain = true
    else:
      args.add a
  if args.len < 2:
    quit "usage: aowlc_parity <in.c.nif> <out.c> [--main]"
  let inp = args[0]
  let outp = args[1]

  var s = State(config: ConfigRef(), bits: sizeof(int)*8)
  s.config.cCompiler = ccGcc
  s.config.appType = appConsole
  s.config.backend = backendC
  # generateCode itself only reads nifcacheDir for the .h side file path; the .c
  # path comes from `outp`. Set it to the output directory to mirror lengc.
  s.config.nifcacheDir = parentDir(outp)

  let flags = if isMain: {gfMainModule} else: {}
  generateCode s, inp, outp, flags

main()
