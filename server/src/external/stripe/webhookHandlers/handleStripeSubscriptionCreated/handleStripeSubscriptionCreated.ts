import { setRootSpanAttributes } from "@/utils/otel/rootSpan.js";
import type { StripeWebhookContext } from "../../webhookMiddlewares/stripeWebhookContext.js";
import { setupStripeSubscriptionCreatedContext } from "./setupStripeSubscriptionCreatedContext.js";
import { autoSyncFromSubscriptionWithLock } from "./tasks/autoSyncFromSubscription.js";
import { linkScheduledCustomerProductsToSubscription } from "./tasks/linkScheduledCustomerProductsToSubscription.js";
import { upsertSubscriptionRow } from "./tasks/upsertSubscriptionRow.js";

export const handleStripeSubscriptionCreated = async ({
	ctx,
}: {
	ctx: StripeWebhookContext;
}) => {
	const subscriptionCreatedContext =
		await setupStripeSubscriptionCreatedContext({ ctx });
	if (!subscriptionCreatedContext) {
		setRootSpanAttributes({ "stripe.webhook.outcome": "skipped_no_customer" });
		return;
	}

	await linkScheduledCustomerProductsToSubscription({
		ctx,
		subscription: subscriptionCreatedContext.subscription,
	});

	await autoSyncFromSubscriptionWithLock({ ctx, subscriptionCreatedContext });

	await upsertSubscriptionRow({
		ctx,
		subscription: subscriptionCreatedContext.subscription,
	});

	setRootSpanAttributes({
		"stripe.webhook.outcome": "subscription_created",
		"stripe.subscription_id": subscriptionCreatedContext.subscription.id,
		"stripe.subscription_status":
			subscriptionCreatedContext.subscription.status,
	});
};
