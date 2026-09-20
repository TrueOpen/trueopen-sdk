export type ChallengeKind = 'VERDICT_FRAUD_PROOF' | 'OBJECTIVE_PROOF' | 'USER_REVALIDATION' | 'RECOMPUTE_REQUEST';
export type OptimisticFinalityStatus = 'PENDING' | 'CHALLENGED' | 'FINAL' | 'OVERTURNED';
export type EvidenceRequestStatus = 'OPEN' | 'SATISFIED' | 'DEFAULTED';
export type ChallengeOutcome =
  | 'NONE'
  | 'SETTLEMENT_OVERTURNED'
  | 'ROLE_FAULT_ONLY'
  | 'USER_REVALIDATION_CONFIRMED'
  | 'USER_REVALIDATION_REJECTED';
