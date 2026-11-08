import { describe, it, expect } from 'vitest'
import { publishReason } from './publish-guard.js'

describe('publishReason', () => {
  it.each([
    ['git remote add origin git@github.com:someone/notes.git', 'git remote add'],
    ['cd /repo && git remote set-url origin https://example.com/x.git', 'git remote set-url'],
    ['git -C /repo remote rename origin old', 'git remote rename'],
    ['git config remote.origin.url https://example.com/x.git', 'git config remote.origin.url'],
    ['git config --global url.git@host:.insteadOf https://host/', 'git config url.git@host:.insteadOf'],
    [
      'git push https://github.com/someone/notes.git main',
      'git push to https://github.com/someone/notes.git, not an existing remote'
    ],
    [
      'git push git@github.com:someone/notes.git',
      'git push to git@github.com:someone/notes.git, not an existing remote'
    ],
    ['git push /mnt/usb/notes.git', 'git push to /mnt/usb/notes.git, not an existing remote'],
    ['gh repo create someone/notes --private --source . --push', 'gh repo create'],
    ['gh repo fork owner/repo', 'gh repo fork'],
    ['rad init --name notes', 'rad init'],
    ['rad node start', 'rad node start'],
    ['sudo -E git remote add up https://x/y.git', 'git remote add'],
    ['bash -c "git remote add origin https://x/y.git"', 'git remote add'],
    ['echo hi\ngh repo create x', 'gh repo create']
  ])('blocks %s', (cmd, reason) => {
    expect(publishReason(cmd)).toBe(reason)
  })

  it.each([
    'git push origin feat/x:feat/x',
    'git push',
    'git push -u origin HEAD',
    'git remote -v',
    'git remote get-url origin',
    'git config --get remote.origin.url',
    'git config remote.origin.url',
    'git commit -m "never git remote add here"',
    'gh pr create --title x',
    'gh repo view owner/repo',
    'rad --version',
    'git clone https://github.com/owner/repo.git'
  ])('allows %s', (cmd) => {
    expect(publishReason(cmd)).toBeUndefined()
  })
})
