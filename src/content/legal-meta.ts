/**
 * Facts about who runs Orbis and the legal documents' version, kept apart from
 * the documents' text so the request proxy can read the version cheaply.
 */
export const LEGAL = {
  /** The registered legal name of the business that runs Orbis, once it exists. Shown where set. */
  operatorName: null as string | null,
  /** Its postal (geographic) address — required by UK e-commerce rules once known. */
  address: null as string | null,
  country: "United Kingdom",
  email: "support@tryorbis.app",
  minimumAge: 13,
  updated: "20 October 2026",
  /**
   * The version users accept. Change it (to the new date) when either document
   * changes in a way users must agree to again: everyone is asked once more.
   */
  version: "2026-10-20",
};
