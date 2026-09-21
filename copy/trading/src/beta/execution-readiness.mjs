import { ROBINHOOD_MAINNET_CHAIN_ID } from "./readiness.mjs";
import { SIGNING_ARCHITECTURES } from "../execution/authorization.mjs";

export function evaluateExecutionLaunchReadiness(input) {
  const blockers = [];
  if (input.chainId !== ROBINHOOD_MAINNET_CHAIN_ID) blockers.push("ROBINHOOD_MAINNET_REQUIRED");
  if (!input.telegramTransportConfigured) blockers.push("TELEGRAM_TRANSPORT_NOT_CONFIGURED");
  if (!input.productionRpcAccepted) blockers.push("PRODUCTION_RPC_NOT_ACCEPTED");
  if (!Object.values(SIGNING_ARCHITECTURES).includes(input.signingArchitecture)) blockers.push("DELEGATED_SIGNER_NOT_CONFIGURED");
  if (!input.activeDelegation) blockers.push("ACTIVE_USER_DELEGATION_REQUIRED");
  if (!input.atomicSpendReservation) blockers.push("ATOMIC_SPEND_RESERVATION_REQUIRED");
  if (!input.mainnetSimulationPassed) blockers.push("MAINNET_SIMULATION_REQUIRED");
  if (!input.monitoringAndPauseReady) blockers.push("MONITORING_AND_PAUSE_REQUIRED");
  if (input.platformFeeBps !== 0 && !input.atomicFeeRouteProven) blockers.push("ATOMIC_FEE_ROUTE_REQUIRED");
  if (!input.broadcastEnabled) blockers.push("BROADCAST_KILL_SWITCH_OFF");
  return Object.freeze({ ready: blockers.length === 0, blockers });
}
