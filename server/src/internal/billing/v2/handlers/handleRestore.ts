import { RestoreParamsV1Schema, Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler";
import { billingActions } from "@/internal/billing/v2/actions";
import { setRootSpanAttributes } from "@/utils/otel/rootSpan.js";

export const handleRestore = createRoute({
	scopes: [Scopes.Billing.Write],
	body: RestoreParamsV1Schema,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const body = c.req.valid("json");

		setRootSpanAttributes({
			"billing.action": "restore",
			"billing.restore.subscription_count": body.subscription_ids?.length,
		});

		const result = await billingActions.restore({
			ctx,
			params: body,
		});

		return c.json(result, 200);
	},
});
