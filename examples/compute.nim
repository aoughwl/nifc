proc gcd(a, b: int): int =
  var x = a
  var y = b
  while y != 0:
    let t = y
    y = x mod y
    x = t
  return x

proc isPrime(n: int): bool =
  if n < 2: return false
  var i = 2
  while i * i <= n:
    if n mod i == 0: return false
    i = i + 1
  return true

proc collatz(n: int): int =
  var x = n
  var steps = 0
  while x != 1:
    if x mod 2 == 0:
      x = x div 2
    else:
      x = 3 * x + 1
    steps = steps + 1
  return steps

proc popcount(x: uint32): int =
  var v = x
  var c = 0
  while v != 0'u32:
    c = c + int(v and 1'u32)
    v = v shr 1'u32
  return c

let g = gcd(48, 36)
let p = isPrime(97)
let c = collatz(27)
let pc = popcount(0xFFu32)
