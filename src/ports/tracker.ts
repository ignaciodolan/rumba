import type { Criterion, LinkedDocument, StateName, Ticket, TicketState } from '../core/types.js'

/** One instance per rumba, built with that rumba's LabelNames. */
export interface Tracker {
  /** Creates the state and signal labels if missing. */
  ensureLabels(): Promise<void>
  /**
   * Open tickets carrying the opt-in label, plus closed ones carrying it whose
   * state label is one of `closedIn`. No ticket twice.
   */
  listCandidates(opts?: { closedIn?: StateName[] }): Promise<Ticket[]>
  getTicket(id: string): Promise<Ticket>
  readState(t: Ticket): Promise<TicketState | null>
  /** Upserts the state comment; leaves exactly one state label. */
  writeState(t: Ticket, s: TicketState): Promise<void>
  postCriteria(t: Ticket, c: Criterion[]): Promise<void>
  readLinkedDocuments(t: Ticket): Promise<LinkedDocument[]>
  removeLabel(t: Ticket, label: string): Promise<void>
  comment(t: Ticket, body: string): Promise<void>
  /** No-op if a comment with this key exists. */
  commentOnce(t: Ticket, key: string, body: string): Promise<void>
}
