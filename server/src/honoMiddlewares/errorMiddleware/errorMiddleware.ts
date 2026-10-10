import { formatZodError, reportError } from "@autumn/errors";
import { type AppEnv, ErrCode, RecaseError } from "@autumn/shared";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import Stripe from "stripe";
import { ZodError } from "zod/v4";
import { logger } from "@/external/logtail/logtailUtils.js";
import { isLogReplacedByMapleTrace } from "@/external/maple/mapleTraceScope.js";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import { getRootSpan, setRootSpanAttributes } from "@/utils/otel/rootSpan.js";
import { callerErrorToRecaseError } from "./callerErrorToRecaseError.js";

/** The API's error contract; bodies are unchanged from before @autumn/errors. */
export const errorToResponse = ({
	c,
	error,
	env,
}: {
	c: Context<HonoEnv>;
	error: Error;
	env: AppEnv;
}) => {
	if (error instanceof RecaseError) {
		if (error.statusCode === 503) c.header("Retry-After", "1");
		return c.json(
			{
				message: error.message,
				code: error.code,
				env,
				...(error.details ? { details: error.details } : {}),
			},
			error.statusCode as ContentfulStatusCode,
		);
	}

	if (error instanceof Stripe.errors.StripeError) {
		return c.json(
			{
				message: `(Stripe Error) ${error.message}`,
				code: ErrCode.StripeError,
				env,
			},
			400,
		);
	}

	if (error instanceof ZodError) {
		return c.json(
			{ message: formatZodError(error), code: ErrCode.InvalidInputs, env },
			500,
		);
	}

	return c.json(
		{
			message: error.message || "Unknown error",
			code: ErrCode.InternalError,
			env,
		},
		500,
	);
};

const MAX_ERROR_MESSAGE_ATTR_LENGTH = 500;

/** The error on the root span. Only a 5xx marks the span failed: a 4xx is the caller's fault. */
const setErrorSpanAttributes = ({
	error,
	statusCode,
}: {
	error: Error;
	statusCode: number;
}) => {
	const { code } = error as { code?: unknown };
	setRootSpanAttributes({
		"error.code": typeof code === "string" ? code : undefined,
		"error.message": error.message?.slice(0, MAX_ERROR_MESSAGE_ATTR_LENGTH),
		"error.type": error.constructor.name,
		"http.response.status_code": statusCode,
	});
	if (statusCode < 500) return;

	const rootSpan = getRootSpan();
	rootSpan?.recordException(error);
	rootSpan?.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
};

/** Hono's error boundary: report through @autumn/errors, then answer with the API's error contract. */
export const errorMiddleware = (err: Error, c: Context<HonoEnv>) => {
	const ctx = c.get("ctx");
	const error = callerErrorToRecaseError({ err, c });

	const report = () =>
		reportError({
			ctx: ctx?.logger ? ctx : { logger },
			error,
			operation: `${c.req.method} ${c.req.routePath}`,
		});

	if (!ctx?.logger) {
		report();
		setErrorSpanAttributes({ error, statusCode: 500 });
		return c.json(
			{ message: "Internal server error", code: ErrCode.InternalError },
			500,
		);
	}
	const response = errorToResponse({ c, error, env: ctx.env });
	setErrorSpanAttributes({ error, statusCode: response.status });
	// A caller error is fully described by its span; a 5xx always logs.
	const isReplacedByTrace = isLogReplacedByMapleTrace({
		traceId: trace.getActiveSpan()?.spanContext().traceId,
		failed: response.status >= 500,
	});
	if (!isReplacedByTrace) report();
	return response;
};
