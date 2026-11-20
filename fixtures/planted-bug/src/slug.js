/** Turns a title into a URL slug: words joined by hyphens, in lower case. */
export function slugify(text) {
  return text.trim().split(/\s+/).join('-')
}
