import {
	AuthType,
	DeleteBalanceParamsV0Schema,
	RouteGroup,
	Scopes,
} from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler";
import { setRootSpanAttributes } from "@/utils/otel/rootSpan.js";
import { deleteBalance } from "../deleteBalance/deleteBalance";

export const handleDeleteBalance = createRoute({
	scopes: [Scopes.Balances.Write],
	routeGroup: RouteGroup.Balances,
	body: DeleteBalanceParamsV0Schema,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const params = c.req.valid("json");

		setRootSpanAttributes({
			"balance.action": "delete",
			"balance.feature_id": params.feature_id,
			"balance.id": params.balance_id,
		});

		await deleteBalance({
			ctx,
			params,
			includeExpired: ctx.authType === AuthType.Dashboard,
		});

		return c.json({ success: true });
	},
});
