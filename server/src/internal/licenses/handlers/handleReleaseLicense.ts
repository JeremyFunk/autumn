import { ReleaseLicenseParamsV0Schema, Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { billingActions } from "@/internal/billing/v2/actions/index.js";
import { buildBillingLockKey } from "@/internal/billing/v2/utils/billingLock/buildBillingLockKey.js";
import { setRootSpanAttributes } from "@/utils/otel/rootSpan.js";

export const handleReleaseLicense = createRoute({
	scopes: [Scopes.Billing.Write],
	body: ReleaseLicenseParamsV0Schema,
	lock:
		process.env.NODE_ENV !== "development"
			? {
					ttlMs: 120000,
					errorMessage:
						"License release already in progress for this customer, try again in a few seconds",
					getKey: (c) => {
						const ctx = c.get("ctx");
						const body = c.req.valid("json");
						return buildBillingLockKey({
							orgId: ctx.org.id,
							env: ctx.env,
							customerId: body.customer_id,
						});
					},
				}
			: undefined,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const body = c.req.valid("json");

		setRootSpanAttributes({
			"billing.action": "release_license",
			"billing.plan_id": body.license_plan_id,
			"billing.license.entity_count": body.entity_ids.length,
		});

		const result = await billingActions.releaseLicense({
			ctx,
			params: body,
		});

		return c.json(result);
	},
});
