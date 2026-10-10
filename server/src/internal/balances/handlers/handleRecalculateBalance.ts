import {
	RecalculateBalanceParamsV0Schema,
	RouteGroup,
	Scopes,
} from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler";
import { setRootSpanAttributes } from "@/utils/otel/rootSpan.js";
import { recalculateBalance } from "../recalculateBalance/recalculateBalance";

export const handleRecalculateBalance = createRoute({
	scopes: [Scopes.Balances.Write],
	routeGroup: RouteGroup.Balances,
	body: RecalculateBalanceParamsV0Schema,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const params = c.req.valid("json");

		setRootSpanAttributes({
			"balance.action": "recalculate",
			"balance.feature_id": params.feature_id,
		});

		await recalculateBalance({
			ctx,
			params,
		});

		return c.json({ success: true });
	},
});
