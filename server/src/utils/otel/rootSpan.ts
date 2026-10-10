import {
	type Attributes,
	context,
	createContextKey,
	type Span,
	trace,
} from "@opentelemetry/api";

const ROOT_SPAN_CONTEXT_KEY = createContextKey("autumn.root_span");

/** Binds the trace's root span, so code under child spans can still reach it. */
export const withRootSpan = <T>({ span, fn }: { span: Span; fn: () => T }): T =>
	context.with(context.active().setValue(ROOT_SPAN_CONTEXT_KEY, span), fn);

/**
 * The bound root span, else the active span. Ended spans are skipped: an
 * early-acked Stripe webhook outlives its root, and writing to an ended span
 * only logs a warning.
 */
export const getRootSpan = (): Span | undefined => {
	const rootSpan = context.active().getValue(ROOT_SPAN_CONTEXT_KEY) as
		| Span
		| undefined;
	return [rootSpan, trace.getActiveSpan()].find((span) => span?.isRecording());
};

/**
 * Stamps what a request or job decided onto its root span. Never throws into
 * the caller; pass a thunk when the attributes take computing.
 */
export const setRootSpanAttributes = (
	attrs: Attributes | (() => Attributes),
) => {
	try {
		const span = getRootSpan();
		if (!span) return;
		const resolved = typeof attrs === "function" ? attrs() : attrs;
		for (const [key, value] of Object.entries(resolved)) {
			if (value === undefined) continue;
			span.setAttribute(key, value);
		}
	} catch {
		// Instrumentation must never fail the request.
	}
};
