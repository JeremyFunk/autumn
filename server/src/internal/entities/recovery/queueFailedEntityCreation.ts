import {
	creationRecoveryGroupId,
	entityCreationRecoveryDedupeId,
	entityCreationRecoveryJob,
} from "@autumn/sqs";
import { SpanKind } from "@opentelemetry/api";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { getSqsJobs } from "@/queue/getSqsJobs.js";
import { withDependencySpan } from "@/utils/otel/withDependencySpan.js";
import type {
	EntityCreationRecoveryParams,
	EntityCreationRecoveryPayload,
} from "./entityCreationRecoveryTypes.js";

/** False, never a throw, when the queue is missing or unreachable: the request's own failure is the answer. */
export const queueFailedEntityCreation = async ({
	ctx,
	params,
}: {
	ctx: AutumnContext;
	params: EntityCreationRecoveryParams;
}): Promise<boolean> => {
	const payload: EntityCreationRecoveryPayload = {
		orgId: ctx.org.id,
		env: ctx.env,
		customerId: params.customerId,
		requestId: ctx.id,
		apiVersion: ctx.apiVersion.value,
		params,
		failedAt: Date.now(),
	};
	const { sent } = await withDependencySpan({
		name: "sqs.send",
		kind: SpanKind.PRODUCER,
		attributes: {
			"messaging.system": "aws_sqs",
			"messaging.operation.type": "send",
			"messaging.destination.name": entityCreationRecoveryJob.queue,
			"autumn.job_name": entityCreationRecoveryJob.name,
		},
		fn: () =>
			getSqsJobs().entityCreationRecovery.trySend(payload, {
				groupId: creationRecoveryGroupId(payload),
				dedupeId: entityCreationRecoveryDedupeId({ payload }),
			}),
	});
	if (!sent) return false;
	ctx.extraLogs.entityCreationRecoveryQueued = true;
	return true;
};
