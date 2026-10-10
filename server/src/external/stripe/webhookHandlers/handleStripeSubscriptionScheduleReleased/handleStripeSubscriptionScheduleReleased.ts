import type Stripe from "stripe";
import { setRootSpanAttributes } from "@/utils/otel/rootSpan.js";
import type { StripeWebhookContext } from "../../webhookMiddlewares/stripeWebhookContext.js";
import type { StripeScheduleReleasedContext } from "./stripeScheduleReleasedContext.js";
import { detachReleasedSchedulePhases } from "./tasks/detachReleasedSchedulePhases.js";

export const handleStripeSubscriptionScheduleReleased = async ({
	ctx,
	event,
}: {
	ctx: StripeWebhookContext;
	event: Stripe.SubscriptionScheduleReleasedEvent;
}) => {
	const eventContext: StripeScheduleReleasedContext = {
		schedule: event.data.object,
		results: {},
	};

	await detachReleasedSchedulePhases({ ctx, eventContext });

	setRootSpanAttributes({
		"stripe.webhook.outcome": "schedule_released",
		"stripe.webhook.detached_phases":
			eventContext.results.detachedSchedulePhases?.detachedCount,
	});

	ctx.handlerResult = { type: event.type, context: eventContext };
};
