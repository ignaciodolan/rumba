/**
 * The first line of every body Rumba writes on GitHub. Rumba may run with a maintainer's own token, so its
 * account is not enough to tell its comments from that maintainer's; this line is. A hidden HTML comment,
 * so readers do not see it. It adds 19 characters, well inside the margin the body limits keep below GitHub's.
 */
export const OWN_MARKER = '<!-- rumba:own -->'

/** `body` with the marker as its first line, added once: a body that already starts with it is returned as it is. */
export function withMarker(body: string): string {
  return isOwnBody(body) ? body : `${OWN_MARKER}\n${body}`
}

/**
 * Whether the first line of `body` is exactly the marker. Only the first line: a person quoting a Rumba comment
 * writes `> <!-- rumba:own -->`, and their text must not pass for Rumba's. Says nothing about who wrote it.
 */
export function isOwnBody(body: string): boolean {
  return body.split(/\r?\n/, 1)[0] === OWN_MARKER
}

/**
 * How the pull request replies Rumba posted before the marker existed begin: the fixed openings its reply code
 * writes (src/core/steps/revise.ts). They cover those older replies only; every reply since carries the marker.
 */
export const LEGACY_REPLY_OPENINGS = [
  'Rumba made no change in this round.',
  'Revised as asked with the ',
  '- Review by ',
  '- Line comment on ',
  '- Comment by ',
  '- Check for ',
] as const

/** Whether `body` reads as a Rumba reply: the marker first, or an older reply's opening. Says nothing about who wrote it. */
export function isOwnReply(body: string): boolean {
  return isOwnBody(body) || LEGACY_REPLY_OPENINGS.some((opening) => body.startsWith(opening))
}
