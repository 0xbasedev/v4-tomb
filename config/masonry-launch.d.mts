export interface MasonryLaunchSummary {
  squareCap: number;
  allocatedSquare: number;
  vestedSquare: number;
  initialLevelFunding: number;
  levelLaunchSupply: number;
}
/** Throws with a field path on the first invalid value; returns totals when the plan reconciles. */
export function validateMasonryLaunch(doc: unknown): MasonryLaunchSummary;
