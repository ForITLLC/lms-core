// ============================================================================
// @foritllc/auth/workload - receive another app's managed-identity token (0.19.0)
//
// The only entry with the receiver. It does not load Next.js, so a Function
// App that only receives calls can use it. Until 0.25.0 the root entry
// re-exported these too, which put jose in every Next.js middleware bundle
// that imported the root.
// ============================================================================

export {
  createWorkloadTokenVerifier,
  parseWorkloadTokenPolicy,
  bearerFromAuthorization,
} from './workload-token.js';
export type {
  WorkloadCaller,
  WorkloadTokenPolicy,
  VerifiedWorkloadCaller,
  WorkloadTokenVerifierOptions,
  WorkloadKeyFetch,
} from './workload-token.js';
