import type { BillingDetailsParams } from "@autumn/shared";
import {
	creationRecoveryGroupId,
	customerCreationRecoveryDedupeId,
	customerCreationRecoveryJob,
} from "@autumn/sqs";
import { SpanKind } from "@opentelemetry/api";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { getSqsJobs } from "@/queue/getSqsJobs.js";
import { withDependencySpan } from "@/utils/otel/withDependencySpan.js";
import type {
	CustomerCreationRecoveryParams,
	CustomerCreationRecoveryPayload,
	CustomerCreationRecoveryStage,
} from "./customerCreationRecoveryTypes.js";

/** False, never a throw, when the queue is missing or unreachable: the request's own failure is the answer. */
export const queueFailedCustomerCreation = async ({
	ctx,
	params,
	billingDetails,
	source,
	withAutumnId,
	failureStage,
}: {
	ctx: AutumnContext;
	params: CustomerCreationRecoveryParams;
	billingDetails?: BillingDetailsParams;
	source?: string;
	withAutumnId?: boolean;
	failureStage: CustomerCreationRecoveryStage;
}): Promise<boolean> => {
	const payload: CustomerCreationRecoveryPayload = {
		orgId: ctx.org.id,
		env: ctx.env,
		customerId: params.customer_id ?? undefined,
		requestId: ctx.id,
		apiVersion: ctx.apiVersion.value,
		params,
		billingDetails,
		source,
		withAutumnId,
		failureStage,
		failedAt: Date.now(),
	};
	const { sent } = await withDependencySpan({
		name: "sqs.send",
		kind: SpanKind.PRODUCER,
		attributes: {
			"messaging.system": "aws_sqs",
			"messaging.operation.type": "send",
			"messaging.destination.name": customerCreationRecoveryJob.queue,
			"autumn.job_name": customerCreationRecoveryJob.name,
		},
		fn: () =>
			getSqsJobs().customerCreationRecovery.trySend(payload, {
				groupId: creationRecoveryGroupId(payload),
				dedupeId: customerCreationRecoveryDedupeId({ payload }),
			}),
	});
	if (!sent) return false;
	ctx.extraLogs.customerCreationRecoveryQueued = { failureStage };
	return true;
};
