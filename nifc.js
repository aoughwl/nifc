// nifc — a .c.nif -> C native backend for nimony.
//
// The cheat it proves: by the time nimony's `hexer` pipeline has lowered a
// program to a `.c.nif` (ARC/destructors injected by destroyer+duplifier+mover,
// closures lifted, iterators inlined, exceptions lowered, generics
// monomorphised, sized types spelled out), all the genuinely hard compiler work
// is done and what remains is a C-shaped tree. A native backend is then just a
// *printer* over that tree — this file. It is nifjs's exact architecture (NIF
// reader + emitter) retargeted from JavaScript to C, and GC is free because ARC
// was already baked into the IR upstream.
//
// The emitter is faithful to Andreas Rumpf's own C generator (nimony/src/lengc:
// codegen.nim / genexprs.nim / genstmts.nim / gentypes.nim / mangler.nim /
// cprelude.nim) for the computational core: procs/funcs, sized numeric/char/
// bool/pointer types, typed arithmetic & bitops (with the wrap-preserving
// cast), comparisons/logic, if/while/scope/case, labels & goto, var/let/gvar/
// const, asgn/store, ret/discard/break, calls, casts/convs, suffixed literals.
// Constructs it has not lowered yet raise `nifc: unsupported …` so gaps are
// visible rather than silently wrong.
(function (global) {
"use strict";

// ----------------------------------------------------------------------------
// NIF S-expression reader (shared shape with nifjs)
// ----------------------------------------------------------------------------
function deEscape(s) {
  return s.replace(/\\([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
// A token may carry trailing line-info: `sym@5`, `sym~2`, `sym@,1,file`. Strip it.
function splitInfo(t) { const m = /[@~]/.exec(t); return m ? t.slice(0, m.index) : t; }

function readNif(src) {
  let i = 0; const n = src.length;
  const ws = () => { while (i < n && /\s/.test(src[i])) i++; };
  function atom() {
    if (src[i] === '"') {                       // string literal
      i++; let s = ""; while (i < n && src[i] !== '"') s += src[i++]; i++;
      while (i < n && !/[\s()]/.test(src[i])) i++;   // consume trailing info
      return { str: deEscape(s) };
    }
    if (src[i] === "'") {                        // char literal
      i++; let s = ""; while (i < n && src[i] !== "'") s += src[i++]; i++;
      while (i < n && !/[\s()]/.test(src[i])) i++;
      const d = deEscape(s); return { chr: d.length ? d.charCodeAt(0) : 0 };
    }
    let t = ""; while (i < n && !/[\s()]/.test(src[i])) t += src[i++];
    let def = false; if (t[0] === ":") { def = true; t = t.slice(1); }
    return { atom: splitInfo(t), def, raw: t };
  }
  function node() {
    ws();
    if (src[i] === "(") {
      i++; ws();
      const f = atom();
      const tag = f.atom !== undefined ? f.atom : "";
      const kids = []; ws();
      while (i < n && src[i] !== ")") { kids.push(node()); ws(); }
      i++;
      return { tag, kids };
    }
    return atom();
  }
  const out = []; ws();
  while (i < n) { out.push(node()); ws(); }
  return out;
}

const isList = (x) => x && x.kids !== undefined;
const isAtom = (x) => x && x.atom !== undefined;
const isDot  = (x) => isAtom(x) && x.atom === ".";

// ----------------------------------------------------------------------------
// Name mangling — faithful port of lengc/mangler.nim mangleToC.
// ----------------------------------------------------------------------------
const HEX = "0123456789ABCDEF";
function escapeChar(ch) {
  const nn = ch.charCodeAt(0);
  return "X" + HEX[(nn >> 4) & 0xF] + HEX[nn & 0xF] + "Q";
}
function mangleToC(s) {
  let r = "", i = 0;
  while (i < s.length) {
    const c = s[i];
    if ((c >= "A" && c <= "P") || (c >= "R" && c <= "Z") ||
        (c >= "a" && c <= "z") || (c >= "0" && c <= "9")) { r += c; }
    else if (c === "Q") r += "QQ";
    else if (c === "_") r += "Q_";
    else if (c === ".") r += "_";
    else if (c === "[") {
      if (s[i + 1] === "]") {
        if (s[i + 2] === "=") { r += "putQ"; i += 2; } else { r += "getQ"; i += 1; }
      } else r += escapeChar(c);
    }
    else if (c === "=") { if (s[i + 1] === "=") { r += "eqQ"; i++; } else r += "eQ"; }
    else if (c === "<") { if (s[i + 1] === "=") { r += "leQ"; i++; } else r += "ltQ"; }
    else if (c === ">") { if (s[i + 1] === "=") { r += "geQ"; i++; } else r += "gtQ"; }
    else if (c === "$") r += "dollarQ";
    else if (c === "%") r += "percentQ";
    else if (c === "&") r += "ampQ";
    else if (c === "^") r += "roofQ";
    else if (c === "!") r += "emarkQ";
    else if (c === "?") r += "qmarkQ";
    else if (c === "*") r += "starQ";
    else if (c === "+") r += "plusQ";
    else if (c === "-") r += "minusQ";
    else if (c === "/") r += "slashQ";
    else if (c === "\\") r += "bslashQ";
    else if (c === "~") r += "tildeQ";
    else if (c === ":") r += "colonQ";
    else if (c === "@") r += "atQ";
    else if (c === "|") r += "barQ";
    else r += escapeChar(c);
    i++;
  }
  return r;
}
// C string literal, faithful to mangler.makeCString / toCChar.
function makeCString(s) {
  let r = '"';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if ((code >= 0 && code <= 0x1F) || (code >= 0x7F)) {
      r += "\\" + code.toString(8);
    } else if (ch === "'" || ch === '"' || ch === "\\" || ch === "?") {
      r += "\\" + ch;
    } else r += ch;
  }
  return r + '"';
}
function toCCharLit(code) {
  if ((code >= 0 && code <= 0x1F) || (code >= 0x7F)) return "'\\" + code.toString(8) + "'";
  const ch = String.fromCharCode(code);
  if (ch === "'" || ch === '"' || ch === "\\" || ch === "?") return "'\\" + ch + "'";
  return "'" + ch + "'";
}

// ----------------------------------------------------------------------------
// Literals
// ----------------------------------------------------------------------------
const isIntLit   = (a) => /^-?\d+$/.test(a);
const isUIntLit  = (a) => /^\d+u(ll|l)?$/.test(a);
const isFloatLit = (a) => /^-?(\d+\.\d*|\.\d+|\d+)(e[-+]?\d+)?$/i.test(a) && /[.e]/i.test(a);

const INT32_MIN = -2147483648, INT32_MAX = 2147483647;
const INT64_MIN = "-9223372036854775808";
function genIntLit(a) {
  // BigInt so 64-bit literals survive. In C, values outside int range need LL.
  let v;
  try { v = BigInt(a); } catch (_) { return a; }
  if (v >= BigInt(INT32_MIN) && v <= BigInt(INT32_MAX)) return v.toString();
  if (a === INT64_MIN) return "(-9223372036854775807LL - 1LL)";
  return v.toString() + "LL";
}
function genUIntLit(a) {
  const digits = a.replace(/u(ll|l)?$/, "");
  const v = BigInt(digits);
  return v <= 4294967295n ? v.toString() + "u" : v.toString() + "ull";
}

// ----------------------------------------------------------------------------
// Emitter
// ----------------------------------------------------------------------------
const TYPED_BIN = { add: " + ", sub: " - ", mul: " * ", div: " / ", mod: " % ",
  shl: " << ", shr: " >> ", ashr: " >> ", bitand: " & ", bitor: " | ", bitxor: " ^ " };
const CMP_BIN = { eq: " == ", neq: " != ", le: " <= ", lt: " < ", ge: " >= ", gt: " > ",
  and: " && ", or: " || " };
const SUFFIX_TYPE = { i64: "NI64", i32: "NI32", i16: "NI16", i8: "NI8",
  u64: "NU64", u32: "NU32", u16: "NU16", u8: "NU8", f64: "NF64", f32: "NF32", f: "NF64" };

class Emitter {
  constructor() {
    this.externOfSym = new Map();   // symbol name -> extern C name (importc/exportc)
    this.typeExtern = new Map();    // type symbol name -> extern C name
    this.noDeclType = new Set();    // type symbols with importc/nodecl -> emit no decl
    this.typeBody = new Map();      // type symbol name -> body node
  }

  // --- pragma helpers -------------------------------------------------------
  externName(pragmasNode) {
    if (!isList(pragmasNode) || pragmasNode.tag !== "pragmas") return null;
    for (const p of pragmasNode.kids) {
      if (isList(p) && (p.tag === "importc" || p.tag === "exportc" || p.tag === "importcpp")) {
        const s = p.kids[0];
        if (s && s.str !== undefined) return s.str;
        if (isAtom(s)) return s.atom;               // bareword extern
        return null;                                // (importc) with no name -> basename
      }
    }
    return null;
  }
  hasPragma(pragmasNode, names) {
    if (!isList(pragmasNode) || pragmasNode.tag !== "pragmas") return false;
    return pragmasNode.kids.some((p) => isList(p) && names.includes(p.tag));
  }
  // symbol -> C name (extern override or mangled)
  symName(name) {
    if (this.externOfSym.has(name)) return this.externOfSym.get(name);
    return mangleToC(name);
  }
  typeName(name) {
    if (this.typeExtern.has(name)) return this.typeExtern.get(name);
    return mangleToC(name);
  }

  // --- types ----------------------------------------------------------------
  bitsOf(t) {
    const last = t.kids.length ? t.kids[t.kids.length - 1] : null;
    if (isAtom(last) && /^-?\d+$/.test(last.atom)) {
      return last.atom === "-1" ? "" : last.atom;
    }
    return "";
  }
  genType(t) {
    if (isDot(t)) return "void";
    if (isAtom(t)) {
      if (t.atom === "void") return "void";
      return this.typeName(t.atom);              // nominal type reference
    }
    if (!isList(t)) throw new Error("nifc: bad type node");
    switch (t.tag) {
      case "i": return "NI" + this.bitsOf(t);
      case "u": return "NU" + this.bitsOf(t);
      case "f": return "NF" + this.bitsOf(t);
      case "c": return "NC" + this.bitsOf(t);
      case "bool": return "NB8";
      case "void": return "void";
      case "ptr": case "aptr": return this.genType(t.kids[0]) + "*";
      case "flexarray": return this.genType(t.kids[0]) + "*";
      case "proctype": return this.genProcTypePtr(t);
      case "array": return this.genType(t.kids[0]) + "*"; // decayed; named arrays use typedefs
      default:
        // sized-type nodes sometimes wrap qualifiers; fall back to first child
        if (t.kids.length) return this.genType(t.kids[0]);
        throw new Error("nifc: unsupported type '" + t.tag + "'");
    }
  }
  genProcTypePtr(t) {
    // (proctype . (params (param ...)...) RET (pragmas ...))  -> RET(*)(args)
    const params = t.kids.find((k) => isList(k) && k.tag === "params");
    const idx = params ? t.kids.indexOf(params) : -1;
    const ret = idx >= 0 ? t.kids[idx + 1] : t.kids[t.kids.length - 1];
    const args = params
      ? params.kids.filter((k) => isList(k) && k.tag === "param").map((p) => this.genType(paramType(p)))
      : [];
    return this.genType(ret) + "(*)(" + (args.join(", ") || "void") + ")";
  }
  // declarator form: type + name in one string (handles pointers, arrays)
  declare(t, name) {
    if (isList(t) && t.tag === "array") {
      const size = t.kids[t.kids.length - 1];
      const len = isAtom(size) ? size.atom : "0";
      return this.genType(t.kids[0]) + " " + name + "[" + len + "]";
    }
    if (isList(t) && t.tag === "proctype") {
      const params = t.kids.find((k) => isList(k) && k.tag === "params");
      const idx = params ? t.kids.indexOf(params) : -1;
      const ret = idx >= 0 ? t.kids[idx + 1] : t.kids[t.kids.length - 1];
      const args = params
        ? params.kids.filter((k) => isList(k) && k.tag === "param").map((p) => this.genType(paramType(p)))
        : [];
      return this.genType(ret) + " (*" + name + ")(" + (args.join(", ") || "void") + ")";
    }
    return this.genType(t) + " " + name;
  }

  // --- expressions ----------------------------------------------------------
  genExpr(e) {
    if (e.str !== undefined) return makeCString(e.str);
    if (e.chr !== undefined) return "(NC8)" + toCCharLit(e.chr);
    if (isAtom(e)) {
      const a = e.atom;
      if (a === "true") return "NIM_TRUE";
      if (a === "false") return "NIM_FALSE";
      if (a === "nil") return "NIM_NIL";
      if (a === "inf") return "INF";
      if (a === "neginf") return "-INF";
      if (a === "nan") return "NAN";
      if (isUIntLit(a)) return genUIntLit(a);
      if (isIntLit(a)) return genIntLit(a);
      if (isFloatLit(a)) return a;
      return this.symName(a);
    }
    if (!isList(e)) throw new Error("nifc: bad expr node");
    const t = e.tag;
    if (TYPED_BIN[t]) {
      const ty = this.genType(e.kids[0]);
      const a = e.kids[e.kids.length - 2], b = e.kids[e.kids.length - 1];
      return "((" + ty + ")(" + this.genExpr(a) + TYPED_BIN[t] + this.genExpr(b) + "))";
    }
    if (CMP_BIN[t]) {
      const a = e.kids[e.kids.length - 2], b = e.kids[e.kids.length - 1];
      return "(" + this.genExpr(a) + CMP_BIN[t] + this.genExpr(b) + ")";
    }
    switch (t) {
      case "neg": return "((" + this.genType(e.kids[0]) + ")-" + this.genExpr(e.kids[e.kids.length - 1]) + ")";
      case "bitnot": return "((" + this.genType(e.kids[0]) + ")~" + this.genExpr(e.kids[e.kids.length - 1]) + ")";
      case "not": return "(!" + this.genExpr(e.kids[e.kids.length - 1]) + ")";
      case "cast": case "conv": case "hconv": case "baseobj":
        return "((" + this.genType(e.kids[0]) + ")" + this.genExpr(e.kids[e.kids.length - 1]) + ")";
      case "call": case "hcall": case "onerr": {
        let start = 1;
        if (t === "onerr") start = 2;              // (onerr action fn args...)
        const fn = this.genExpr(e.kids[start - 1]);
        const args = e.kids.slice(start).map((x) => this.genExpr(x));
        return fn + "(" + args.join(", ") + ")";
      }
      case "suf": {
        const val = e.kids[0], suf = e.kids[1];
        if (val && val.str !== undefined) return this.genExpr(val);
        const sname = isAtom(suf) ? suf.atom : (suf && suf.str);
        const ty = SUFFIX_TYPE[sname] || "NI64";
        return "((" + ty + ")" + this.genExpr(val) + ")";
      }
      case "paren": case "expr": return "(" + this.genExpr(e.kids[e.kids.length - 1]) + ")";
      case "addr": return "(&" + this.genExpr(e.kids[0]) + ")";
      case "deref": case "hderef": return "(*" + this.genExpr(e.kids[0]) + ")";
      case "at": return this.genExpr(e.kids[0]) + ".a[" + this.genExpr(e.kids[1]) + "]";
      case "pat": return this.genExpr(e.kids[0]) + "[" + this.genExpr(e.kids[1]) + "]";
      case "dot": {
        const obj = this.genExpr(e.kids[0]);
        const fld = e.kids[1];
        let inh = "";
        if (e.kids[2] && isAtom(e.kids[2]) && /^\d+$/.test(e.kids[2].atom)) {
          inh = ".Q".repeat(parseInt(e.kids[2].atom, 10));
        }
        const fname = isAtom(fld) ? mangleToC(fld.atom) : this.genExpr(fld);
        return obj + inh + "." + fname;
      }
      case "sizeof": return "sizeof(" + this.genType(e.kids[0]) + ")";
      case "alignof": return "NIM_ALIGNOF(" + this.genType(e.kids[0]) + ")";
      case "true": return "NIM_TRUE";
      case "false": return "NIM_FALSE";
      case "nil": return "NIM_NIL";
      case "inf": return "INF";
      case "neginf": return "-INF";
      case "nan": return "NAN";
      case "oconstr": case "aconstr": return this.genConstr(e);
      case "ovf": return "LENGC_OVF_";   // read the overflow flag set by (keepovf ...)
      default: throw new Error("nifc: unsupported expr '" + t + "'");
    }
  }
  genConstr(e) {
    // (oconstr TYPE (kv field val)...) | (aconstr TYPE val...)
    const ty = this.genType(e.kids[0]);
    if (e.tag === "aconstr") {
      const vals = e.kids.slice(1).map((x) => this.genExpr(x));
      return "(" + ty + "){ .a = { " + vals.join(", ") + " } }";
    }
    const parts = [];
    for (const kv of e.kids.slice(1)) {
      if (isList(kv) && kv.tag === "kv") {
        const fld = kv.kids[0];
        const fname = isAtom(fld) ? mangleToC(fld.atom) : this.genExpr(fld);
        parts.push("." + fname + " = " + this.genExpr(kv.kids[1]));
      } else {
        parts.push(this.genExpr(kv));
      }
    }
    return "(" + ty + "){ " + parts.join(", ") + " }";
  }

  // --- statements -----------------------------------------------------------
  genStmt(s) {
    if (isDot(s)) return "";
    if (!isList(s)) return "";
    switch (s.tag) {
      case "stmts": return s.kids.map((k) => this.genStmt(k)).filter(Boolean).join("\n");
      case "scope": {
        const body = s.kids.map((k) => this.genStmt(k)).filter(Boolean).join("\n");
        return "{\n" + body + "\n}";
      }
      case "var": case "let": case "cursor": case "const":
      case "gvar": case "glet": case "tvar":
        return this.genLocalVar(s);
      case "asgn":
        return this.genLvalue(s.kids[0]) + " = " + this.genExpr(s.kids[1]) + ";";
      case "store":  // (store value lvalue)
        return this.genLvalue(s.kids[1]) + " = " + this.genExpr(s.kids[0]) + ";";
      case "ret":
        return isDot(s.kids[0]) || s.kids.length === 0 ? "return;"
          : "return " + this.genExpr(s.kids[0]) + ";";
      case "if": return this.genIf(s);
      case "while":
        return "while (" + this.condExpr(s.kids[0]) + ") {\n" + this.genStmt(s.kids[1]) + "\n}";
      case "loop": {  // lengc genLoop: while(1){ pre; if(!(cond)) break; body }
        const pre = this.genStmt(s.kids[0]);
        const cond = this.genExpr(s.kids[1]);
        const body = this.genStmt(s.kids[2]);
        return "while (NIM_TRUE) {\n" + pre + "\nif (!(" + cond + ")) break;\n" + body + "\n}";
      }
      case "break": return "break;";
      case "continue": return "continue;";
      case "call": case "hcall": return this.genExpr(s) + ";";
      case "onerr": return this.genExpr(s) + ";";
      case "discard": return "(void)(" + this.genExpr(s.kids[0]) + ");";
      case "lab": {
        const nm = isAtom(s.kids[0]) ? mangleToC(s.kids[0].atom) : "L";
        return nm + ": ;";
      }
      case "jmp": {
        const nm = isAtom(s.kids[0]) ? mangleToC(s.kids[0].atom) : "L";
        return "goto " + nm + ";";
      }
      case "case": return this.genCase(s);
      case "keepovf": return this.genKeepOverflow(s);
      case "raise":
        return "/* raise */ (void)0;";  // exceptions already lowered by eraiser; bare raise is a trap
      case "pragmas": case "comment": case "emit": case "smry": return "";
      default: throw new Error("nifc: unsupported stmt '" + s.tag + "'");
    }
  }
  // if() condition without doubled parens for comparisons
  condExpr(n) {
    if (isList(n) && CMP_BIN[n.tag]) {
      const a = n.kids[n.kids.length - 2], b = n.kids[n.kids.length - 1];
      return this.genExpr(a) + CMP_BIN[n.tag] + this.genExpr(b);
    }
    return this.genExpr(n);
  }
  genIf(s) {
    let out = "", firstElif = true;
    for (const br of s.kids) {
      if (!isList(br)) continue;
      if (br.tag === "elif") {
        out += (firstElif ? "if (" : " else if (") + this.condExpr(br.kids[0]) + ") {\n"
          + this.genStmt(br.kids[1]) + "\n}";
        firstElif = false;
      } else if (br.tag === "else") {
        out += " else {\n" + this.genStmt(br.kids[0]) + "\n}";
      }
    }
    return out;
  }
  genCase(s) {
    let out = "switch (" + this.condExpr(s.kids[0]) + ") {\n";
    for (const br of s.kids.slice(1)) {
      if (!isList(br)) continue;
      if (br.tag === "of") {
        const ranges = br.kids[0], body = br.kids[1];
        const labels = [];
        const vals = isList(ranges) && ranges.tag === "ranges" ? ranges.kids : [ranges];
        for (const v of vals) {
          if (isList(v) && v.tag === "range") {
            labels.push("case " + this.genExpr(v.kids[0]) + " ... " + this.genExpr(v.kids[1]) + ":");
          } else labels.push("case " + this.genExpr(v) + ":");
        }
        out += labels.join("\n") + " {\n" + this.genStmt(body) + "\nbreak;\n}\n";
      } else if (br.tag === "else") {
        out += "default: {\n" + this.genStmt(br.kids[0]) + "\nbreak;\n}\n";
      }
    }
    return out + "}";
  }
  genKeepOverflow(s) {
    // (keepovf (add|sub|mul (i N) a b) lvalue) using gcc builtins
    const op = s.kids[0], lval = s.kids[1];
    const builtin = { add: "__builtin_add_overflow", sub: "__builtin_sub_overflow",
      mul: "__builtin_mul_overflow" }[op.tag];
    if (!builtin) throw new Error("nifc: unsupported keepovf op '" + op.tag + "'");
    const a = op.kids[op.kids.length - 2], b = op.kids[op.kids.length - 1];
    return "if (" + builtin + "(" + this.genExpr(a) + ", " + this.genExpr(b) + ", &"
      + this.genLvalue(lval) + ")) { LENGC_OVF_ = LENGC_OVF_ || NIM_TRUE; }";
  }
  genLvalue(n) {
    if (isAtom(n)) return this.symName(n.atom);
    return this.genExpr(n);
  }
  genLocalVar(s) {
    // (var name pragmas type value)
    const nameAtom = s.kids[0];
    const pragmas = s.kids[1];
    let type = s.kids[2];
    const value = s.kids[3];
    const isConst = s.tag === "const";
    const nm = isAtom(nameAtom) ? this.declName(nameAtom.atom, pragmas) : "v";
    // infer from initializer if the type slot is empty
    if (isDot(type)) type = null;
    const hasInit = value !== undefined && !isDot(value);
    let decl = type ? this.declare(type, nm) : "NI " + nm;
    if (isConst) decl = "static const " + decl;
    return decl + (hasInit ? " = " + this.genExpr(value) : "") + ";";
  }
  declName(name, pragmas) {
    const ext = this.externName(pragmas);
    if (ext) return ext;
    if (isList(pragmas) && this.hasPragma(pragmas, ["importc", "exportc", "importcpp"])) {
      // (importc) with no string -> basename before mangling
      return name.split(".")[0];
    }
    return mangleToC(name);
  }

  // --- procs ----------------------------------------------------------------
  procParts(p) {
    const nameAtom = p.kids[0];
    const params = p.kids.find((k) => isList(k) && k.tag === "params");
    let ret, body, pragmas = null;
    // ret is the node immediately after params; body is the last stmts node
    if (params) {
      const pi = p.kids.indexOf(params);
      ret = p.kids[pi + 1];
    } else {
      ret = p.kids[1];
    }
    for (let j = p.kids.length - 1; j >= 0; j--) {
      if (isList(p.kids[j]) && p.kids[j].tag === "stmts") { body = p.kids[j]; break; }
    }
    pragmas = p.kids.find((k) => isList(k) && k.tag === "pragmas") || null;
    const pnodes = params ? params.kids.filter((k) => isList(k) && k.tag === "param") : [];
    return { nameAtom, params, ret, body, pragmas, pnodes };
  }
  procSignature(p) {
    const { nameAtom, ret, pragmas, pnodes } = this.procParts(p);
    const name = this.declName(nameAtom.atom, pragmas);
    const retC = ret === undefined || isDot(ret) ? "void" : this.genType(ret);
    const args = pnodes.map((pp) => {
      const pn = pp.kids[0];
      const pt = paramType(pp);
      return this.declare(pt, mangleToC(pn.atom));
    });
    let prefix = "";
    if (pragmas && this.hasPragma(pragmas, ["inline"])) prefix = "static inline ";
    return { name, sig: prefix + retC + " " + name + "(" + (args.join(", ") || "void") + ")" };
  }
  genProc(p) {
    const { body } = this.procParts(p);
    const { sig } = this.procSignature(p);
    if (!body) return sig + ";";               // prototype only (imported/no body)
    return sig + " {\n" + this.genStmt(body) + "\n}";
  }

  // --- globals --------------------------------------------------------------
  genGlobal(g) {
    // (gvar name pragmas type value)
    const nameAtom = g.kids[0], pragmas = g.kids[1], type = g.kids[2], value = g.kids[3];
    const nm = this.declName(nameAtom.atom, pragmas);
    const isConst = g.tag === "const";
    let decl = this.declare(type, nm);
    if (isConst) decl = "static const " + decl;
    const hasInit = value !== undefined && !isDot(value) && isLiteralNode(value);
    return { name: nm, decl: decl + (hasInit ? " = " + this.genExpr(value) : "") + ";",
             nameAtom: nameAtom.atom, needsInit: value !== undefined && !isDot(value) && !hasInit,
             value };
  }

  // --- type declarations ----------------------------------------------------
  genTypeDecl(td) {
    // (type name pragmas body)
    const nameAtom = td.kids[0];
    const pragmas = td.kids.find((k) => isList(k) && k.tag === "pragmas");
    const body = td.kids[td.kids.length - 1];
    if (this.hasPragma(pragmas, ["nodecl", "importc", "importcpp", "header"])) return null;
    const nm = mangleToC(nameAtom.atom);
    if (isList(body)) {
      if (body.tag === "object" || body.tag === "union") {
        return this.genObjectDecl(nm, body, body.tag === "union");
      }
      if (body.tag === "enum") return this.genEnumDecl(nm, body);
      if (body.tag === "array") {
        const size = body.kids[body.kids.length - 1];
        const len = isAtom(size) ? size.atom : "0";
        return "typedef struct " + nm + " { " + this.genType(body.kids[0]) + " a[" + len + "]; } " + nm + ";";
      }
      if (body.tag === "proctype") {
        return "typedef " + this.declare(body, nm) + ";";
      }
      if (["i", "u", "f", "c", "bool", "ptr", "aptr"].includes(body.tag)) {
        return "typedef " + this.declare(body, nm) + ";";   // distinct/alias
      }
    }
    if (isAtom(body)) return "typedef " + this.typeName(body.atom) + " " + nm + ";";
    return null;
  }
  genObjectDecl(nm, body, isUnion) {
    const kw = isUnion ? "typedef union " : "typedef struct ";
    let fields = "";
    let start = 0;
    // optional inheritance parent as first child (Symbol) or '.'
    if (body.kids.length && (isDot(body.kids[0]) || isAtom(body.kids[0]))) {
      if (isAtom(body.kids[0]) && !isDot(body.kids[0])) {
        fields += this.typeName(body.kids[0].atom) + " Q;\n";
      }
      start = 1;
    }
    for (const f of body.kids.slice(start)) {
      if (isList(f) && f.tag === "fld") {
        const fn = f.kids[0];
        const ftype = f.kids[f.kids.length - 1];
        fields += this.declare(ftype, mangleToC(fn.atom)) + ";\n";
      }
    }
    return kw + nm + " {\n" + fields + "} " + nm + ";";
  }
  genEnumDecl(nm, body) {
    const base = body.kids[0];
    let out = "typedef " + this.genType(base) + " " + nm + ";\n";
    for (const ef of body.kids.slice(1)) {
      if (isList(ef) && ef.tag === "efld") {
        const en = ef.kids[0], ev = ef.kids[1];
        out += "#define " + mangleToC(en.atom) + " ((" + this.genType(base) + ")" + this.genExpr(ev) + ")\n";
      }
    }
    return out;
  }
}

function paramType(paramNode) {
  // (param name pragmas type [default])
  const lists = paramNode.kids.filter((k) => isList(k) || (isAtom(k) && k.atom === "."));
  // type is the first list child that is a type (skip the leading name atom & '.')
  for (let i = 1; i < paramNode.kids.length; i++) {
    const k = paramNode.kids[i];
    if (isList(k) || (isAtom(k) && k.atom !== "." && !k.def)) return k;
  }
  return paramNode.kids[2];
}
function isLiteralNode(v) {
  if (v === undefined) return false;
  if (v.str !== undefined || v.chr !== undefined) return true;
  if (isAtom(v)) {
    const a = v.atom;
    return a === "." || a === "true" || a === "false" || a === "nil" ||
      isIntLit(a) || isUIntLit(a) || isFloatLit(a);
  }
  if (isList(v)) {
    if (["suf", "true", "false", "nil", "inf", "neginf", "nan", "cast", "conv"].includes(v.tag)) return true;
    if (v.tag === "aconstr" || v.tag === "oconstr") {
      return v.kids.slice(1).every((k) => (isList(k) && k.tag === "kv" ? isLiteralNode(k.kids[1]) : isLiteralNode(k)));
    }
  }
  return false;
}

// ----------------------------------------------------------------------------
// C runtime prelude (subset of lengc/cprelude.nim — the primitive typedefs and
// macros the printer relies on). Self-contained: no nimony runtime needed for
// the arithmetic/control-flow core.
// ----------------------------------------------------------------------------
const PRELUDE = `/* GENERATED BY nifc. DO NOT EDIT. */
#define NIM_INTBITS 64
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <math.h>

#define NIM_NIL NULL
#define NB8 _Bool
typedef unsigned char NC8;
typedef uint16_t NC16;
typedef uint32_t NC32;
typedef float  NF32;
typedef double NF64;
typedef double NF;
typedef int8_t  NI8;  typedef int16_t  NI16; typedef int32_t  NI32; typedef int64_t  NI64;
typedef uint8_t NU8;  typedef uint16_t NU16; typedef uint32_t NU32; typedef uint64_t NU64;
typedef NI64 NI;      typedef NU64 NU;

#define NIM_TRUE true
#define NIM_FALSE false
#ifndef INF
#  ifdef INFINITY
#    define INF INFINITY
#  else
#    define INF (1.0/0.0)
#  endif
#endif
#if defined(__GNUC__) || defined(_MSC_VER)
#  define IL64(x) x##LL
#else
#  define IL64(x) ((NI64)x)
#endif
#define NIM_ALIGN(x)  __attribute__((aligned(x)))
#define NIM_ALIGNOF(x) __alignof__(x)
#if defined(__GNUC__) || defined(__clang__)
#  pragma GCC diagnostic ignored "-Wpointer-sign"
#  pragma GCC diagnostic ignored "-Wunused-label"
#  pragma GCC diagnostic ignored "-Wunused-variable"
#  pragma GCC diagnostic ignored "-Wunused-function"
#endif
`;

// ----------------------------------------------------------------------------
// Module compilation
// ----------------------------------------------------------------------------
const STMT_TAGS = new Set(["asgn", "store", "call", "hcall", "if", "while", "loop",
  "case", "scope", "lab", "jmp", "discard", "onerr", "keepovf", "raise", "ret", "break"]);

function classify(nodes) {
  const root = nodes.find((n) => isList(n) && n.tag === "stmts");
  if (!root) throw new Error("nifc: no top-level (stmts …) found — is this a .c.nif?");
  const procs = [], globals = [], types = [], topStmts = [];
  for (const d of root.kids) {
    if (!isList(d)) continue;
    if (d.tag === "proc" || d.tag === "func") procs.push(d);
    else if (d.tag === "gvar" || d.tag === "tvar" || d.tag === "glet" || d.tag === "var" ||
             d.tag === "const" || d.tag === "let") globals.push(d);
    else if (d.tag === "type") types.push(d);
    else if (STMT_TAGS.has(d.tag)) topStmts.push(d);
  }
  return { root, procs, globals, types, topStmts };
}

function buildExternMaps(em, procs, globals, types) {
  for (const p of procs) {
    const parts = em.procParts(p);
    const ext = em.externName(parts.pragmas);
    if (ext) em.externOfSym.set(parts.nameAtom.atom, ext);
    else if (em.hasPragma(parts.pragmas, ["importc", "exportc", "importcpp"]))
      em.externOfSym.set(parts.nameAtom.atom, parts.nameAtom.atom.split(".")[0]);
  }
  for (const g of globals) {
    const nameAtom = g.kids[0], pragmas = g.kids[1];
    const ext = em.externName(pragmas);
    if (ext) em.externOfSym.set(nameAtom.atom, ext);
  }
  for (const td of types) {
    const nameAtom = td.kids[0];
    const pragmas = td.kids.find((k) => isList(k) && k.tag === "pragmas");
    const ext = em.externName(pragmas);
    if (ext) em.typeExtern.set(nameAtom.atom, ext);
    if (em.hasPragma(pragmas, ["nodecl", "importc", "importcpp", "header"]))
      em.noDeclType.add(nameAtom.atom);
    em.typeBody.set(nameAtom.atom, td.kids[td.kids.length - 1]);
  }
}

// Collect call targets referenced anywhere in a subtree.
function collectCalls(node, out) {
  if (!node) return;
  if (isList(node)) {
    if ((node.tag === "call" || node.tag === "hcall") && node.kids[0] && isAtom(node.kids[0])) {
      out.add(node.kids[0].atom);
    }
    if (node.tag === "onerr" && node.kids[1] && isAtom(node.kids[1])) out.add(node.kids[1].atom);
    for (const k of node.kids) collectCalls(k, out);
  }
  return out;
}
// Collect symbol references (for global reachability) in a subtree.
function collectSyms(node, out) {
  if (!node) return out;
  if (isAtom(node) && !node.def) {
    const a = node.atom;
    if (/^[A-Za-z`]/.test(a) && !isIntLit(a) && !isUIntLit(a) && !isFloatLit(a) &&
        !["true", "false", "nil", "inf", "neginf", "nan", "."].includes(a)) out.add(a);
  } else if (isList(node)) {
    for (const k of node.kids) collectSyms(k, out);
  }
  return out;
}

// Emit a complete, self-contained C translation unit for the whole module.
function compileModule(snif, opts = {}) {
  const nodes = readNif(snif);
  const { procs, globals, types, topStmts } = classify(nodes);
  const em = new Emitter();
  buildExternMaps(em, procs, globals, types);

  const definedSyms = new Set();
  const procByName = new Map();
  for (const p of procs) { const nm = em.procParts(p).nameAtom.atom; procByName.set(nm, p); definedSyms.add(nm); }
  for (const g of globals) definedSyms.add(g.kids[0].atom);

  // Forward-declare every object/union struct first, so a typedef that points
  // to a struct defined later in source order still resolves (C11 lets the full
  // `typedef struct NM {..} NM;` redeclare the same typedef).
  const fwdDecls = [];
  for (const td of types) {
    const pragmas = td.kids.find((k) => isList(k) && k.tag === "pragmas");
    if (em.hasPragma(pragmas, ["nodecl", "importc", "importcpp", "header"])) continue;
    const body = td.kids[td.kids.length - 1];
    if (isList(body) && (body.tag === "object" || body.tag === "union")) {
      const nm = mangleToC(td.kids[0].atom);
      fwdDecls.push("typedef " + (body.tag === "union" ? "union " : "struct ") + nm + " " + nm + ";");
    }
  }

  // type declarations (skip nodecl/importc)
  const typeDecls = [];
  for (const td of types) { const s = em.genTypeDecl(td); if (s) typeDecls.push(s); }

  // prototypes for all procs (order-independent calls)
  const protos = [];
  const defs = [];
  for (const p of procs) {
    const parts = em.procParts(p);
    const sig = em.procSignature(p);
    if (!parts.body) { protos.push(sig.sig + ";"); continue; }
    // Emit a prototype for every proc, inline included: a `static inline` proc
    // called before its definition otherwise gets an implicit (non-static)
    // declaration, which then conflicts with the real static one.
    protos.push(sig.sig + ";");
    defs.push(em.genProc(p));
  }

  // weak stubs for unresolved external calls so the unit links standalone
  const calledSyms = new Set();
  for (const p of procs) collectCalls(em.procParts(p).body, calledSyms);
  for (const s of topStmts) collectCalls(s, calledSyms);
  const stubs = [];
  if (opts.stubExterns !== false) {
    for (const c of calledSyms) {
      if (!definedSyms.has(c)) stubs.push("NI64 " + em.symName(c) + "() { return 0; }");
    }
  }

  // globals + their deferred (non-literal) initialisers
  const data = [], inits = [];
  for (const g of globals) {
    const info = em.genGlobal(g);
    data.push(info.decl);
    if (info.needsInit) inits.push(em.symName(info.nameAtom) + " = " + em.genExpr(info.value) + ";");
  }
  for (const s of topStmts) { const c = em.genStmt(s); if (c) inits.push(c); }

  let out = PRELUDE + "\n";
  out += "/* --- error/overflow flags --- */\n_Thread_local NB8 LENGC_ERR_;\n_Thread_local NB8 LENGC_OVF_;\n\n";
  if (fwdDecls.length) out += "/* --- forward type declarations --- */\n" + fwdDecls.join("\n") + "\n\n";
  if (typeDecls.length) out += "/* --- types --- */\n" + typeDecls.join("\n") + "\n\n";
  if (protos.length) out += "/* --- prototypes --- */\n" + protos.join("\n") + "\n\n";
  if (stubs.length) out += "/* --- external stubs --- */\n" + stubs.join("\n") + "\n\n";
  if (data.length) out += "/* --- globals --- */\n" + data.join("\n") + "\n\n";
  if (defs.length) out += "/* --- procedures --- */\n" + defs.join("\n\n") + "\n\n";
  if (inits.length) {
    out += "static void __attribute__((constructor)) nifc_init(void) {\n" + inits.join("\n") + "\n}\n";
  }
  return indentC(out);
}

// Emit a self-contained C program that calls one entry proc and prints its
// result. Only the procs and globals transitively reachable from the entry are
// emitted, so the nimony bootstrap (ini/main/cmdCount/cmdLine and its
// cross-module calls into the system runtime) is excluded and the program is
// fully standalone.
function compileHarness(snif, entry, argExprs = []) {
  const nodes = readNif(snif);
  const { procs, globals, types } = classify(nodes);
  const em = new Emitter();
  buildExternMaps(em, procs, globals, types);

  const procByName = new Map();
  for (const p of procs) procByName.set(em.procParts(p).nameAtom.atom, p);
  const globalByName = new Map();
  for (const g of globals) globalByName.set(g.kids[0].atom, g);

  // resolve entry: accept the bare name, or a name whose base matches
  let entryName = null;
  for (const nm of procByName.keys()) {
    if (nm === entry || nm.replace(/\.+$/, "") === entry || nm.split(".")[0] === entry) { entryName = nm; break; }
  }
  if (!entryName) throw new Error("nifc: entry proc '" + entry + "' not found. Available: " +
    [...procByName.keys()].map((n) => n.split(".")[0]).join(", "));

  // BFS over in-module calls
  const reached = new Set(), queue = [entryName];
  while (queue.length) {
    const nm = queue.shift();
    if (reached.has(nm)) continue;
    reached.add(nm);
    const calls = collectCalls(em.procParts(procByName.get(nm)).body, new Set());
    for (const c of calls) if (procByName.has(c) && !reached.has(c)) queue.push(c);
  }
  // globals referenced by reached procs
  const usedGlobals = new Set();
  for (const nm of reached) {
    const syms = collectSyms(em.procParts(procByName.get(nm)).body, new Set());
    for (const s of syms) if (globalByName.has(s)) usedGlobals.add(s);
  }

  const typeDecls = [];
  for (const td of types) { const s = em.genTypeDecl(td); if (s) typeDecls.push(s); }
  const protos = [], defs = [];
  for (const nm of reached) {
    const p = procByName.get(nm);
    protos.push(em.procSignature(p).sig + ";");
    defs.push(em.genProc(p));
  }
  const data = [];
  for (const nm of usedGlobals) data.push(em.genGlobal(globalByName.get(nm)).decl);

  // format the entry's result by its return type
  const parts = em.procParts(procByName.get(entryName));
  const retC = parts.ret === undefined || isDot(parts.ret) ? "void" : em.genType(parts.ret);
  const call = em.symName(entryName) + "(" + argExprs.join(", ") + ")";
  let mainBody;
  if (retC === "void") {
    mainBody = "  " + call + ";\n  printf(\"(void)\\n\");";
  } else {
    let fmt = "%lld", cast = "(long long)";
    if (/^NU/.test(retC)) { fmt = "%llu"; cast = "(unsigned long long)"; }
    else if (/^NF/.test(retC)) { fmt = "%.17g"; cast = "(double)"; }
    else if (retC === "NB8") { fmt = "%d"; cast = "(int)"; }
    else if (/^NC8/.test(retC)) { fmt = "%c"; cast = "(char)"; }
    mainBody = "  printf(\"" + fmt + "\\n\", " + cast + call + ");";
  }

  let out = PRELUDE + "\n#include <stdio.h>\n\n";
  out += "_Thread_local NB8 LENGC_ERR_;\n_Thread_local NB8 LENGC_OVF_;\n\n";
  if (typeDecls.length) out += typeDecls.join("\n") + "\n\n";
  if (protos.length) out += protos.join("\n") + "\n\n";
  if (data.length) out += data.join("\n") + "\n\n";
  if (defs.length) out += defs.join("\n\n") + "\n\n";
  out += "int main(void) {\n" + mainBody + "\n  return 0;\n}\n";
  return indentC(out);
}

// Cheap brace-based re-indentation so the emitted C is readable.
function indentC(src) {
  const lines = src.split("\n");
  let depth = 0; const out = [];
  for (let raw of lines) {
    const line = raw.trim();
    if (line === "") { out.push(""); continue; }
    if (line[0] === "#") { out.push(line); continue; }   // preprocessor at col 0
    let d = depth;
    if (line[0] === "}") d = Math.max(0, depth - 1);
    out.push("  ".repeat(d) + line);
    for (const ch of line) { if (ch === "{") depth++; else if (ch === "}") depth = Math.max(0, depth - 1); }
  }
  return out.join("\n");
}

const api = { readNif, mangleToC, compileModule, compileHarness, Emitter, PRELUDE };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (global) global.NifC = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
