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
