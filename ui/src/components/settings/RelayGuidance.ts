export type RelayPrimaryAction =
  | "connect-cloudflare"
  | "refresh-accounts"
  | "deploy-worker"
  | "bind-domain"
  | null;

export type RelayGuidanceInput = {
  cloudflareAuthenticated: boolean;
  needsAccountRefresh: boolean;
  hasAccount: boolean;
  hasWorker: boolean;
  hasZone: boolean;
  hasCustomDomain: boolean;
  customDomainRecommended: boolean;
};

export function relayPrimaryAction(input: RelayGuidanceInput): RelayPrimaryAction {
  if (!input.cloudflareAuthenticated) return "connect-cloudflare";
  if (input.needsAccountRefresh) return "refresh-accounts";
  if (!input.hasAccount) return null;
  if (!input.hasWorker) return "deploy-worker";
  if (!input.hasCustomDomain && input.hasZone && input.customDomainRecommended) return "bind-domain";
  return null;
}
