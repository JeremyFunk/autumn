import { FinalizeLockParamsV0Schema, RouteGroup, Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler";
import { setRootSpanAttributes } from "@/utils/otel/rootSpan.js";
import { runFinalizeLock } from "../finalizeLock/runFinalizeLock.js";

export const handleFinalizeLock = createRoute({
	scopes: [Scopes.Balances.Write],
	routeGroup: RouteGroup.Balances,
	body: FinalizeLockParamsV0Schema,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const params = c.req.valid("json");

		setRootSpanAttributes({
			"balance.action": "finalize_lock",
			"lock.id": params.lock_id,
			"lock.action": params.action,
		});

		const response = await runFinalizeLock({ ctx, params });
		const status = ctx.extraLogs.finalizeLockQueuedForReplay ? 202 : 200;
		setRootSpanAttributes({ "lock.queued": status === 202 || undefined });

		return c.json(response, status);
	},
});
