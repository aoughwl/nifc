proc fib(n: int): int =
  if n < 2: return n
  return fib(n - 1) + fib(n - 2)

proc sumTo(n: int): int =
  var s = 0
  var i = 0
  while i <= n:
    s = s + i
    i = i + 1
  return s

let a = fib(10)
let b = sumTo(100)
