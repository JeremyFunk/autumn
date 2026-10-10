import { Scopes, SyncParamsV1Schema } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler";
import { billingActions } from "@/internal/billing/v2/actions";
import { setRootSpanAttributes } from "@/utils/otel/rootSpan.js";

export const handleSyncV2 = createRoute({
	scopes: [Scopes.Billing.Write],
	body: SyncParamsV1Schema,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const body = c.req.valid("json");

		setRootSpanAttributes({
			"billing.action": "sync_v2",
			"stripe.subscription_id": body.stripe_subscription_id,
			"stripe.schedule_id": body.stripe_schedule_id,
		});

		const result = await billingActions.syncV2({
			ctx,
			params: body,
			tags: ["resync"],
		});

		return c.json(result, 200);
	},
});
