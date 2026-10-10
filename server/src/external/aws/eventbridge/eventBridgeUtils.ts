import {
	CreateScheduleCommand,
	DeleteScheduleCommand,
	ResourceNotFoundException,
} from "@aws-sdk/client-scheduler";
import { logger } from "@/external/logtail/logtailUtils.js";
import { deriveSqsQueueArn } from "@/queue/utils/deriveSqsQueueArn.js";
import { withDependencySpan } from "@/utils/otel/withDependencySpan.js";
import { schedulerClient } from "./initEventBridge.js";

const SCHEDULE_GROUP = "default";
const SCHEDULER_ROLE_ARN = process.env.AWS_EVENTBRIDGE_SCHEDULER_ROLE_ARN || "";

const schedulerSpanAttributes = ({
	method,
	scheduleName,
}: {
	method: string;
	scheduleName: string;
}) => ({
	"rpc.system": "aws-api",
	"rpc.service": "EventBridgeScheduler",
	"rpc.method": method,
	"aws.eventbridge.schedule_name": scheduleName,
});

const getSqsQueueArn = (): string =>
	deriveSqsQueueArn({ queueUrl: process.env.SQS_QUEUE_URL_V2 || "" });

/** Creates a one-shot EventBridge schedule that delivers an SQS message at scheduleAt */
export const createSchedule = async ({
	scheduleName,
	scheduleAt,
	sqsMessageBody,
	messageGroupId,
}: {
	scheduleName: string;
	scheduleAt: Date;
	sqsMessageBody: string;
	messageGroupId: string;
}) => {
	// EventBridge at-expression: at(yyyy-mm-ddThh:mm:ss)
	const pad = (n: number) => String(n).padStart(2, "0");
	const d = scheduleAt;
	const atExpression = `at(${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())})`;

	const sqsArn = getSqsQueueArn();
	logger.info(
		`[EventBridge] Creating schedule: name=${scheduleName} arn=${sqsArn} at=${atExpression}`,
	);

	await withDependencySpan({
		name: "eventbridge.create_schedule",
		attributes: schedulerSpanAttributes({
			method: "CreateSchedule",
			scheduleName,
		}),
		fn: () =>
			schedulerClient.send(
				new CreateScheduleCommand({
					Name: scheduleName,
					GroupName: SCHEDULE_GROUP,
					ScheduleExpression: atExpression,
					ScheduleExpressionTimezone: "UTC",
					FlexibleTimeWindow: { Mode: "OFF" },
					Target: {
						Arn: sqsArn,
						RoleArn: SCHEDULER_ROLE_ARN,
						Input: sqsMessageBody,
						SqsParameters: {
							MessageGroupId: messageGroupId,
						},
					},
					// Auto-delete after firing so schedules don't accumulate
					ActionAfterCompletion: "DELETE",
				}),
			),
	});
};

/** Deletes an EventBridge schedule by name. Silently ignores not-found errors. */
export const deleteSchedule = async ({
	scheduleName,
}: {
	scheduleName: string;
}) =>
	// The span wraps the not-found handling, so a schedule that already fired is not an error.
	withDependencySpan({
		name: "eventbridge.delete_schedule",
		attributes: schedulerSpanAttributes({
			method: "DeleteSchedule",
			scheduleName,
		}),
		fn: async () => {
			try {
				await schedulerClient.send(
					new DeleteScheduleCommand({
						Name: scheduleName,
						GroupName: SCHEDULE_GROUP,
					}),
				);
			} catch (error) {
				if (error instanceof ResourceNotFoundException) return;
				throw error;
			}
		},
	});
