export const rangeBindings: Record<string, string>;
export function masonryPlanBlockers(plan: unknown, opts?: Record<string, unknown>): string[];
export function onchainBlockers(input: { code: Record<string, string | undefined>; rangeManagerOf?: Record<string, string>; plan: { addresses: Record<string, string> }; decimalsRead?: number; decimalsExpected?: number }): string[];
export function manifestBlockers(protocol: unknown, frontend: unknown, registry: unknown): string[];
