import { hostname } from "node:os";
import {
	type BalanceWorkerClient,
	createKafkaBalanceWorkerClient,
	createProxyBalanceWorkerClient,
	type KafkaBalanceWorkerClientConfig,
} from "@autumn/balance-worker-client";
import { getAutumnEnv } from "@autumn/env";
import {
	getBalanceWorkerClientEnv,
	getBalanceWorkerTransportEnv,
} from "@autumn/env/balanceWorkerClient";
import {
	BALANCE_WORKER_OWNERSHIP_CATCH_UP_TIMEOUT_MS,
	BALANCE_WORKER_REQUEST_TIMEOUT_MS,
	BALANCE_WORKER_ROUTE_REFRESH_TIMEOUT_MS,
} from "@autumn/env/balanceWorkerConstants";
import { logger } from "@/external/logtail/logtailUtils.js";
import { isMapleEnabled } from "@/external/maple/mapleEnabled.js";
import { withDependencySpan } from "@/utils/otel/withDependencySpan.js";
import { readBalanceWorkerKafkaConfig } from "./balanceWorkerKafkaConfig.js";
import { getBalanceWorkerRolloutOverride } from "./getBalanceWorkerRolloutEnabled.js";

const rolloutOverrideLabel = (): string => {
	const override = getBalanceWorkerRolloutOverride();
	if (override === undefined) return "config";
	return override ? "on" : "off";
};

let balanceWorkerClient: BalanceWorkerClient | undefined;

function balanceWorkerClientConfig(): KafkaBalanceWorkerClientConfig {
	const env = getBalanceWorkerClientEnv();
	return {
		kafka: readBalanceWorkerKafkaConfig({
			clientId: "autumn-server-balance-worker",
		}),
		ownershipTopic: env.BALANCE_WORKER_OWNERSHIP_TOPIC,
		commandTopic: env.BALANCE_WORKER_COMMAND_TOPIC,
		catalogInvalidationTopic: env.BALANCE_WORKER_CATALOG_INVALIDATION_TOPIC,
		groupIdPrefix: "autumn-server-ownership",
		partitionCount: env.BALANCE_WORKER_PARTITION_COUNT,
		timeoutMs: BALANCE_WORKER_REQUEST_TIMEOUT_MS,
		// This client serves customer check and track calls, so a partition in
		// the middle of moving has to fail quickly rather than hold the request.
		routeRefreshTimeoutMs: BALANCE_WORKER_ROUTE_REFRESH_TIMEOUT_MS,
		catchUpTimeoutMs: BALANCE_WORKER_OWNERSHIP_CATCH_UP_TIMEOUT_MS,
		// Every server evicts and publishes, so the connect is paid at boot, not by the first request's append.
		connectProducersOnStart: true,
	};
}

/** Outside the VPC (Trigger, prod scripts) every call goes through the API's own client. */
function createProxyClient(): BalanceWorkerClient {
	const secret = getBalanceWorkerTransportEnv().BALANCE_WORKER_PROXY_SECRET;
	if (!secret)
		throw new Error(
			"BALANCE_WORKER_PROXY_SECRET is required to reach the balance worker from outside the VPC",
		);
	return createProxyBalanceWorkerClient({
		ctx: {},
		config: {
			url: getAutumnEnv().AUTUMN_PUBLIC_API_URL,
			secret,
			caller: hostname().slice(0, 64),
		},
	});
}

function createClientForTransport(): BalanceWorkerClient {
	if (getBalanceWorkerTransportEnv().BALANCE_WORKER_TRANSPORT === "proxy")
		return createProxyClient();
	return createKafkaBalanceWorkerClient({
		ctx: { logger },
		config: balanceWorkerClientConfig(),
	});
}

/** A client span around each direct command; queued commands and catalog invalidations pass through as they are. */
function withBalanceWorkerSpans(
	client: BalanceWorkerClient,
): BalanceWorkerClient {
	if (!isMapleEnabled) return client;
	const traced =
		<P, R>(method: string, call: (params: P) => Promise<R>) =>
		(params: P) =>
			withDependencySpan({
				name: `balance_worker.${method}`,
				attributes: {
					"rpc.system": "http",
					"rpc.service": "balance-worker",
					"rpc.method": method,
				},
				fn: () => call(params),
			});
	return {
		...client,
		track: traced("track", client.track),
		check: traced("check", client.check),
		readSubjectState: traced("readSubjectState", client.readSubjectState),
		initialize: traced("initialize", client.initialize),
		applyBillingPlan: traced("applyBillingPlan", client.applyBillingPlan),
		evict: traced("evict", client.evict),
		flush: traced("flush", client.flush),
		finalize: traced("finalize", client.finalize),
		confirmExpiredLock: traced("confirmExpiredLock", client.confirmExpiredLock),
		reset: traced("reset", client.reset),
		updateBalance: traced("updateBalance", client.updateBalance),
		deleteBalance: traced("deleteBalance", client.deleteBalance),
		recalculateBalance: traced("recalculateBalance", client.recalculateBalance),
	};
}

/** Routing answers "no owner" until `startBalanceWorkerClient` has read the ownership log through. */
export function getBalanceWorkerClient(): BalanceWorkerClient {
	balanceWorkerClient ??= withBalanceWorkerSpans(createClientForTransport());
	return balanceWorkerClient;
}

/**
 * Retries until the ownership log is read through; callers must not let it gate their listener.
 * Started whatever the rollout says: evicts and catalog invalidations reach the workers either way, so a flip never finds stale memory.
 */
export async function startBalanceWorkerClient(): Promise<void> {
	logger.info(
		`[balance-worker] Client starting; rollout ${rolloutOverrideLabel()}`,
	);
	await getBalanceWorkerClient().start();
}

export async function stopBalanceWorkerClient(): Promise<void> {
	const running = balanceWorkerClient;
	balanceWorkerClient = undefined;
	await running?.stop();
}
