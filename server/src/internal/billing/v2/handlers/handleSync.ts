import { SyncParamsV0Schema, Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler";
import { billingActions } from "@/internal/billing/v2/actions";
import { setRootSpanAttributes } from "@/utils/otel/rootSpan.js";

export const handleSync = createRoute({
	scopes: [Scopes.Billing.Write],
	body: SyncParamsV0Schema,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const body = c.req.valid("json");

		setRootSpanAttributes(() => ({
			"billing.action": "sync",
			"billing.plan_ids": body.mappings
				.map((mapping) => mapping.plan_id)
				.slice(0, 10)
				.join(","),
		}));

		const result = await billingActions.sync({
			ctx,
			params: body,
		});

		return c.json(result, 200);
	},
});
