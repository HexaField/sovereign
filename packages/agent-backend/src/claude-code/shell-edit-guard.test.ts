import { describe, expect, it } from 'vitest'
import { shellEditReason } from './shell-edit-guard.js'

describe('shellEditReason', () => {
  it.each([
    // In-place editors, however they are spelled or wrapped.
    ["sed -i 's/a/b/' src/x.ts", 'sed -i'],
    ["sed -Ei.bak 's/a/b/' src/x.ts", 'sed -i'],
    ["cd repo && sed --in-place 's/a/b/' x.ts", 'sed -i'],
    ["/usr/bin/sed -i 's/a/b/' x.ts", 'sed -i'],
    ["gsed -i 's/a/b/' x.ts", 'sed -i'],
    ["find . -name '*.ts' | xargs sed -i 's/a/b/'", 'sed -i'],
    ["X=1 sudo sed -i 's/a/b/' x.ts", 'sed -i'],
    ["perl -pi -e 's/a/b/' x.ts", 'perl -i'],
    ["perl -0pi -e 's/a/b/' x.ts", 'perl -i'],
    ['ruby -pi -e \'gsub(/a/, "b")\' x.rb', 'ruby -i'],
    ["awk -i inplace '{print}' x.txt", 'awk -i inplace'],
    // Authoring a file with cat/echo/printf/tee.
    ["cat > src/new.ts <<'EOF'\nexport const a = 1\nEOF", 'cat writes content to src/new.ts'],
    ['cat <<EOF > notes.md\nhello\nEOF', 'cat writes content to notes.md'],
    ['echo "dist/" >> .gitignore', 'echo writes content to .gitignore'],
    ['echo foo 1> x.txt', 'echo writes content to x.txt'],
    ['echo hi >| out.txt', 'echo writes content to out.txt'],
    ['cat f &> x.txt', 'cat writes content to x.txt'],
    ['echo x > /tmp/../home/me/x', 'echo writes content to /tmp/../home/me/x'],
    ["printf 'x\\n' > /home/me/repo/a.txt", 'printf writes content to /home/me/repo/a.txt'],
    ["tee -a README.md <<'EOF'\nmore\nEOF", 'tee writes content to README.md'],
    ['echo more | tee -a README.md', 'tee writes content to README.md'],
    ['tee x.md <<< "content"', 'tee writes content to x.md'],
    // Through a nested shell.
    ["bash -c 'echo x > src/a'", 'echo writes content to src/a'],
    ["sh -c 'sed -i s/a/b/ x'", 'sed -i'],
    // Scripts that write files.
    [
      "python3 - <<'EOF'\np='/home/me/repo/plan.md'\ns=open(p).read()\nopen(p,'w').write(s.replace('a','b'))\nEOF",
      'a python3 script writes a file named by a variable'
    ],
    ["python3 -c \"open('src/x.py', 'a').write('y')\"", 'a python3 script writes src/x.py'],
    ["python3 -c \"from pathlib import Path; Path('x.md').write_text('y')\"", 'a python3 script writes x.md'],
    ['node -e "require(\'fs\').writeFileSync(f, s)"', 'a node script writes a file named by a variable'],
    ["deno eval \"Deno.writeTextFileSync('x.ts', 'y')\"", 'a deno script writes x.ts'],
    ["bun -e \"await Bun.write('x.ts', 'y')\"", 'a bun script writes x.ts']
  ])('blocks %j', (command, reason) => {
    expect(shellEditReason(command)).toContain(reason)
  })

  it.each([
    // Reading, searching, running.
    'git status && git diff --stat',
    "sed -n '1,40p' src/x.ts",
    "sed -n 's/ -inline//p' x.css",
    "perl -Mstrict -ne 'print' f",
    "grep -rn 'foo' src | head",
    "cat src/x.ts | grep -n 'a'",
    'node --version && grep -rn "writeFile(" src',
    // Output redirects of commands that do not author content.
    'pnpm test > /tmp/test.log 2>&1',
    'pnpm build 2>/dev/null',
    'git diff > review.patch',
    'pnpm vitest run 2>&1 | tee test.log',
    'curl -sSo out.json https://example.com',
    // Quoted text is never syntax.
    "git commit -m 'docs: explain the sed -i ban'",
    "gh pr create --body 'Replace perl -pi usage'",
    'echo "==> step 1"',
    "echo 'a -> b'",
    "printf '%s -> %s\\n' a b",
    'echo "Usage: x <file> [opts]"',
    'git commit -m "use writeFile(path) in node script"',
    'git commit -m "$(cat <<\'EOF\'\nfix: x > y\nEOF\n)"',
    'echo $((1 > 2))',
    // Scratch files.
    "cat > /tmp/probe/script.mjs <<'EOF'\nimport fs from 'node:fs'\nfs.writeFileSync(out, data)\necho x > y\nEOF\nnode /tmp/probe/script.mjs",
    'echo "hello" > /dev/null',
    'echo done | tee /tmp/log.txt',
    'echo x > "${TMPDIR:-/tmp}/x"',
    'cat <<\\EOF > /tmp/x\necho y > z\nEOF',
    "python3 -c \"import json; print(json.load(open('data.json'))['a'])\"",
    "python3 - <<'EOF'\nimport csv\nwith open('/tmp/out.csv', 'w', newline='') as f:\n    csv.writer(f).writerow([1])\nEOF",
    "node -e \"require('fs').writeFileSync('/tmp/x.json', '{}')\""
  ])('allows %j', (command) => {
    expect(shellEditReason(command)).toBeUndefined()
  })

  it('allows in-place edits, authoring and scripts whose files are all scratch', () => {
    expect(shellEditReason("cd /tmp/bard && sed -i 's/a/b/' build.py")).toBeUndefined()
    expect(shellEditReason("sed -i -e 's/a/b/' /tmp/a.txt /tmp/b.txt")).toBeUndefined()
    expect(shellEditReason("sed -i 's/a/b/' /tmp/a.txt src/b.ts")).toContain('sed -i')
    expect(shellEditReason("awk -i inplace '{print}' /tmp/a.txt")).toBeUndefined()
    expect(shellEditReason("find . | xargs sed -i 's/a/b/'")).toContain('sed -i') // files unknown
    expect(
      shellEditReason("cd /tmp/bard && python3 - <<'PY'\ns=open('build.py').read()\nopen('build.py','w').write(s)\nPY")
    ).toBeUndefined()
    expect(shellEditReason('cd /tmp/bard && cd ../../home/me && echo x > a.txt')).toContain('echo writes')
    expect(shellEditReason('T=$(mktemp -d) && cat > $T/check.ts <<EOF\nx\nEOF')).toBeUndefined()
    expect(shellEditReason('S=~/.claude/settings.json; cat > "$S" <<EOF\nx\nEOF')).toContain('cat writes content to $S')
  })

  it('reads every line after a here-string or a quoted <<', () => {
    expect(shellEditReason('cat <<< "hello"\nsed -i s/a/b/ x')).toContain('sed -i')
    expect(shellEditReason('echo "see <<EOF"\nsed -i s/a/b/ x')).toContain('sed -i')
  })
})
