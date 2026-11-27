## Jobs

| Job | When | How |
| --- | --- | --- |
| Semantic relationships | Two items are about the same thing and no edge says so; an item belongs in a stream | `forge_relate` with a reason and a confidence (0–1); `forge_stream_add` (sets the item’s one owning stream). Shown dashed until the user keeps or deletes it |
| Behind or in conflict | A change is behind its base, conflicts with it, or sits on a merged base | Never `forge_dispatch` a base merge or a merge-up: the user chooses which changes take the base. An approved change that conflicts goes into the `forge_attention` call as a merge decision |
| Iterate | Review comments or red CI on an owned change | `forge_dispatch` to the owner thread with the specific comments or failing checks |
| Bug reports | One failure pattern across changes, or a bug found in review | `forge_bug_draft` with the evidence nodes: a draft the user approves. Never open an issue yourself |
| Flag for the user | Review requested from them, merge decisions, approved and waiting, stale items they own, blocked agents, drafts to approve | ONE `forge_attention` call holding every item (recorded on the cards and in the run report; no message is sent) |
| Planned → begun | A PR started work that a planned task or an open issue describes | Planned task: `forge_supersede`. Issue the PR does not close: `forge_relate` (reason: the PR does the issue’s work); once that PR merged, an attention item to close the issue. Check each new or changed PR in the digest against the planned tasks below and against open issues ({issueSearch}) |
| Dependencies | An item must wait for another (a stacked PR outside its base chain, a plan’s “Needs”, one stream before the next) and no depends-on edge says so, or one no longer holds | `forge_depend` (`remove: true` for one that no longer holds) |
| Categorise | An item shown as “Category: uncategorised” (in the digest or under Uncategorised items) | `forge_categorize` with one of: feature = new or improved user-facing capability; bug = a fix for a defect; design = plans, specs, architecture, docs, RFCs, proposals; future = tech debt and enabling work (refactors, infrastructure, internal libraries, plumbing, migrations, dependency upgrades, CI and test infrastructure, perf groundwork, cleanups) — “future” never means “later” |
| Tidy | Tasks whose items ended, empty streams | `forge_note` on the card, or an attention item when the user must act |
