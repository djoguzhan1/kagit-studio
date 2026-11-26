export const AI_MONTHLY_HARD_CAP_USD: number;
export const AI_DAILY_FREE_NEURONS: number;
export const AI_USD_PER_1K_NEURONS: number;
export const AI_MODEL_DIRECTOR: string;
export const AI_MODEL_SIDE_GUIDE: string;
export const AI_NEURONS_DIRECTOR_EST: number;
export const AI_NEURONS_SIDE_GUIDE_EST: number;

export function computeBillableUsdForCall(todayNeuronsBefore: number, callNeurons: number): number;

export function checkAiBudgetAndQuota(
  env: unknown,
  actorKey: string,
  signedIn: boolean,
  feature: 'direct_film' | 'side_guide',
  estNeurons: number
): Promise<{
  allowed: boolean;
  reason?: 'budget_capped' | 'daily_limit';
  used: number;
  limit: number;
  billableUsd: number;
  monthUsd: number;
  todayNeurons: number;
  dayKey: string;
  monthKey: string;
}>;

declare const workerDefault: {
  fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
};
export default workerDefault;
