# Recognise Rumba's own comments by a marker, not by author alone

Requested by the owner before stage 2's lessons. A common setup runs Rumba with the maintainer's own GitHub token, so Rumba posts as the same account the maintainer reviews with. Today everything written by that account counts as Rumba's own: the maintainer's reviews, line comments and `rumba-revise` label are ignored, and the feedback loop can never start for that user.

## Rule

- **The marker.** Every body Rumba writes on GitHub starts with one hidden line, exactly `<!-- rumba:own -->`, followed by a newline: pull request bodies (opened and updated), pull request replies, and every issue comment (state comment, exit and status comments, criteria comment, `commentOnce` notes). A helper adds it once (never twice) at the adapter, so no write path can miss it.
- **Rumba's own comment.** A pull request comment is Rumba's own only when its author is the account Rumba runs as AND the first line of its body is exactly the marker. The first line only: a person who quotes a Rumba comment writes it as `> <!-- rumba:own -->`, which is not the marker, so the quote never hides the person's text. A comment by Rumba's account without the marker on its first line is a person using the same account, treated like any other writer (that account has write access by definition; its permission is still looked up as for everyone).
- **Replies from before the marker.** For the transition, a pull request comment by Rumba's account without the marker still counts as Rumba's own when its body starts with one of the fixed openings Rumba's replies were written with: `Rumba made no change in this round.`, `Revised as asked with the `, `- Review by `, `- Line comment on `, `- Comment by `, `- Check for `. The list sits next to the marker in `src/core/marker.ts`. It applies to Rumba's account only: a person's comment that starts the same way is never Rumba's.
- **Reviews and line comments.** Rumba never submits reviews or line comments, so one by Rumba's account is always a person's.
- **The revise label.** Rumba never adds `rumba-revise` (it only removes it; the only labels it adds are its state labels on tickets), so a revise label added by Rumba's own account counts as added by a person, subject to the usual checks (write access, added after the last push).
- **State comments.** Unchanged in trust: read only from Rumba's account and only with the state marker inside the comment, as today, so nobody else can forge them. Existing state comments without the new first line are still read.
- **Linear.** Linear comments are never read as feedback; the state comment is recognised by author and the state marker as today. Linear's comments are left without the new first line, since its renderer is not known to hide HTML comments.

## Task 1: the marker and the rule

Files: a new `src/core/marker.ts` (`OWN_MARKER`, `withMarker(body)`, `isOwnBody(body)`), `src/adapters/codeHost/github.ts` (writes: `openPullRequest` including its update path, `updatePullRequest`, `commentOnPullRequest`; reads: `listFeedback`'s `self`, `labelAdded`'s `self`), `src/adapters/tracker/github.ts` (every write), `src/core/steps/trackPullRequest.ts` (the label rule), `src/core/feedback.ts` if needed, tests.

- Tests (test first, invented examples: maintainer `alice` whose token Rumba uses, reviewer `bob`, `#42`):
  - `withMarker` adds the line once; `isOwnBody` is true only for the exact first line (`\r\n` accepted), false for a quoted marker, a marker later in the body, leading spaces or text before it.
  - Every GitHub write path sends a body starting with the marker (code host and tracker), and the state comment still round-trips.
  - `listFeedback`: a comment by Rumba's account with the marker is `self`; the same account without the marker is not `self`; a person's comment quoting a Rumba reply is not `self`; a review and a line comment by Rumba's account are never `self`.
  - Core: with Rumba running as `alice`, alice's changes-requested review starts a round and her comment is stored; Rumba's earlier reply (marked) is never stored; a revise label added by `alice` (Rumba's own account) after the push starts a round.
  - A state comment with the marker written by another account is still ignored.
