export function add(a: number, b: number): number {
  return a + b
}

export function multiply(a: number, b: number): number {
  let total = 0
  for (let i = 0; i < b; i++) total = add(total, a)
  return total
}
