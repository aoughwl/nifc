proc power(base: float, n: int): float =
  var r = 1.0
  var i = 0
  while i < n:
    r = r * base
    i = i + 1
  return r

proc classify(n: int): int =
  case n
  of 0: return 100
  of 1, 2, 3: return 200
  of 10..20: return 300
  else: return 999

proc absf(x: float): float =
  if x < 0.0: return -x
  return x

let a = power(2.0, 10)
let b = classify(15)
let c = absf(-3.5)
