import type { StripeWebhookContext } from "@/external/stripe/webhookMiddlewares/stripeWebhookContext";
import { addToExtraLogs } from "@/utils/logging/addToExtraLogs";
import { setRootSpanAttributes } from "@/utils/otel/rootSpan.js";
import type { StripeSubscriptionDeletedContext } from "../handleStripeSubscriptionDeleted/setupStripeSubscriptionDeletedContext";
import type { StripeSubscriptionUpdatedContext } from "../handleStripeSubscriptionUpdated/stripeSubscriptionUpdatedContext";

type EventContext =
	| StripeSubscriptionUpdatedContext
	| StripeSubscriptionDeletedContext;

/**
 * Logs all customer product updates, deletions, and insertions in a structured format for easy querying in Axiom.
 * Called at the end of subscription handlers to provide a summary.
 */
export const logCustomerProductUpdates = ({
	ctx,
	eventContext,
}: {
	ctx: StripeWebhookContext;
	eventContext: EventContext;
}): void => {
	const {
		updatedCustomerProducts,
		deletedCustomerProducts,
		insertedCustomerProducts,
	} = eventContext;

	const updates = updatedCustomerProducts.map(
		({ customerProduct, updates }) => ({
			id: customerProduct.id,
			productId: customerProduct.product.id,
			productName: customerProduct.product.name,
			statusBefore: customerProduct.status,
			updates,
		}),
	);

	const deletions = deletedCustomerProducts.map((customerProduct) => ({
		id: customerProduct.id,
		productId: customerProduct.product.id,
		productName: customerProduct.product.name,
		status: customerProduct.status,
	}));

	const insertions = insertedCustomerProducts.map((customerProduct) => ({
		id: customerProduct.id,
		productId: customerProduct.product.id,
		productName: customerProduct.product.name,
		status: customerProduct.status,
	}));

	const oneOffPrepaidCarryOvers =
		"oneOffPrepaidCarryOvers" in eventContext
			? eventContext.oneOffPrepaidCarryOvers
			: [];

	if (
		updates.length === 0 &&
		deletions.length === 0 &&
		insertions.length === 0 &&
		oneOffPrepaidCarryOvers.length === 0
	)
		return;

	setRootSpanAttributes({
		"stripe.webhook.plan_id":
			[
				...new Set(
					[...updates, ...deletions, ...insertions].map(
						({ productId }) => productId,
					),
				),
			]
				.slice(0, 10)
				.join(",") || undefined,
		"stripe.webhook.customer_products_updated": updates.length,
		"stripe.webhook.customer_products_deleted": deletions.length,
		"stripe.webhook.customer_products_inserted": insertions.length,
	});

	addToExtraLogs({
		ctx,
		extras: {
			updates,
			deletions,
			insertions,
			...(oneOffPrepaidCarryOvers.length > 0
				? { oneOffPrepaidCarryOvers }
				: {}),
		},
	});
};
