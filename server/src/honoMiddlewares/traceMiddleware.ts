import { context, trace } from "@opentelemetry/api";
import type { MiddlewareHandler } from "hono";
import { getMapleTraceMark } from "@/external/maple/mapleTraceScope.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { isBalanceWorkerRolloutEnabled } from "@/internal/misc/rollouts/isBalanceWorkerRolloutEnabled.js";

import {
	type TenantAttrs,
	withTenantContext,
} from "@/utils/otel/tenantContext.js";

const MAX_REQUEST_BODY_ATTR_LENGTH = 2048;

/**
 * Stamps tenant attrs onto the root HTTP span, then wraps the rest of the
 * chain in an OTel context carrying the same attrs so TenantAttrSpanProcessor
 * propagates them to every child span. Must run AFTER auth/seeder middleware
 * that populates ctx. Works on any router whose ctx extends AutumnContext
 * (apiRouter, internalRouter, stripe/vercel/revenueCat webhook routers, etc).
 */
export const traceEnrichMiddleware: MiddlewareHandler = async (c, next) => {
	const ctx = c.get("ctx") as AutumnContext | undefined;
	if (!ctx) return next();

	const attrs: TenantAttrs = {
		req_id: ctx.id,
		org_id: ctx.org?.id,
		org_slug: ctx.org?.slug,
		env: ctx.env,
		customer_id: ctx.customerId,
		entity_id: ctx.entityId,
		user_id: ctx.userId || undefined,
		auth_type: ctx.authType,
		api_version: ctx.apiVersion?.semver,
		region: process.env.AWS_REGION,
		balance_worker_rollout_enabled:
			ctx.org && ctx.customerId
				? isBalanceWorkerRolloutEnabled({ ctx, customerId: ctx.customerId })
				: undefined,
	};

	const rootSpan = trace.getSpan(context.active());
	if (rootSpan) {
		for (const [key, value] of Object.entries(attrs)) {
			if (value === undefined) continue;
			rootSpan.setAttribute(key, value);
		}
		if (ctx.apiKeyId) rootSpan.setAttribute("api_key_id", ctx.apiKeyId);

		// Kept traces answer "what was asked"; sampled ones stay small.
		const body = ctx.requestLogContext?.body;
		const { traceId } = rootSpan.spanContext();
		if (body && getMapleTraceMark(traceId)?.mode === "keep") {
			rootSpan.setAttribute(
				"http.request.body",
				JSON.stringify(body).slice(0, MAX_REQUEST_BODY_ATTR_LENGTH),
			);
		}
	}

	return withTenantContext({ attrs, fn: () => next() });
};
