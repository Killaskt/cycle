---
id: 004
title: Tag repository — fuzzy-match reuse + creation-time classification
status: open
blocked_by: [001]
---

## Scope

`CONTEXT.md` §9a: tags are user-created, 1-3 words, offered as a dropdown of existing tags + "something else." Fuzzy-match new entries against existing tags to resist vocabulary fragmentation. **New** tags only require one extra binary tap at creation — `availability` or `motivation` classification (`tags.classification`). Reused/fuzzy-matched tags inherit their existing classification, no re-prompt.

Seed the `disinterest` tag with `classification: 'motivation'` for every user on first use (per `CONTEXT.md` §9a — "disinterest... is motivation-flavored").

## Definition of done

- Fuzzy-match test: a near-duplicate label ("tired" vs "tierd") resolves to the existing tag, not a new row.
- Creation test: a genuinely new label requires and stores a classification; attempting to create without one fails validation.
- Reuse test: selecting an existing tag never re-prompts for classification.
- Seed test: `disinterest` exists with `classification: 'motivation'` after first tag-repository use for a fresh user.

## Notes
