// The bounds of the lesson records a ticket keeps, apart from lessons.ts so the state schema can
// read them without loading the code that draws lessons.

/** How many lesson records a ticket keeps, the latest. */
export const LESSONS_KEPT = 10
/** The most characters of a lesson record's reason. */
export const LESSON_REASON_MAX = 500
