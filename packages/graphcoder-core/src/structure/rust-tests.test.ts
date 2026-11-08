import { describe, expect, it } from 'vitest'
import { matchingBrace, rustTestCases, rustTestRanges } from './rust-tests.js'

const SRC = `use std::fmt;

pub fn add(a: i32, b: i32) -> i32 {
    let s = "}{"; // a } in a comment
    let c = '}';
    a + b
}

fn borrow<'a>(s: &'a str) -> &'a str { s }

#[cfg(test)]
mod tests {
    use super::*;

    /* a block comment with { and /* nested */ } */
    fn helper() -> i32 { 1 }

    #[test]
    fn adds() {
        assert_eq!(add(1, 2), 3);
    }

    #[tokio::test(flavor = "multi_thread")]
    #[serial]
    async fn adds_async() {
        let raw = r#"}"#;
        assert_eq!(add(helper(), 1), 2);
    }
}

#[cfg(test)]
pub(crate) mod more {
    #[rstest]
    pub fn adds() {}
}
`

describe('rustTestRanges', () => {
  it('finds each #[cfg(test)] module from the attribute to its closing brace', () => {
    expect(rustTestRanges(SRC)).toEqual([
      [11, 29],
      [31, 35]
    ])
  })

  it('finds none in a file without test modules', () => {
    expect(rustTestRanges('fn main() {}\n#[cfg(test)]\nfn alone() {}\n')).toEqual([])
  })
})

describe('rustTestCases', () => {
  const cases = rustTestCases('src/lib.rs', SRC)

  it('lists the functions with a test attribute, not helpers, as callable cases', () => {
    expect(cases.map((c) => [c.name, c.start, c.end, c.callable])).toEqual([
      ['adds', 18, 21, true],
      ['adds_async', 23, 28, true],
      ['adds #2', 33, 34, true]
    ])
    expect(cases[0].id).toBe('src/lib.rs::adds')
  })
})

describe('matchingBrace', () => {
  it('skips braces in strings, chars, raw strings and comments, but not after a lifetime', () => {
    const open = SRC.indexOf('{', SRC.indexOf('pub fn add'))
    expect(SRC.slice(matchingBrace(SRC, open) - 6, matchingBrace(SRC, open) + 1)).toBe('a + b\n}')
    const b = SRC.indexOf('{', SRC.indexOf("fn borrow<'a>"))
    expect(SRC.slice(b, matchingBrace(SRC, b) + 1)).toBe('{ s }')
  })

  it('answers -1 for a brace that never closes', () => {
    expect(matchingBrace('fn f() { "unterminated', 7)).toBe(-1)
  })
})
