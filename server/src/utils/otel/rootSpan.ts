import {
	type Attributes,
	type Context,
	context,
	createContextKey,
	type Span,
} from "@opentelemetry/api";

import { isMapleEnabled } from "@/external/maple/mapleEnabled.js";

const ROOT_SPAN_CONTEXT_KEY = createContextKey("autumn.root_span");

/**
 * Binds the span that carries a unit of work's outcome: the HTTP root for a
 * request, the job span for a worker, and the deferred span for the part of an
 * early-acked Stripe webhook that runs after the response.
 */
export const setRootSpan = ({
	context: parentContext,
	span,
}: {
	context: Context;
	span: Span;
}): Context => parentContext.setValue(ROOT_SPAN_CONTEXT_KEY, span);

export const withRootSpan = <T>({ span, fn }: { span: Span; fn: () => T }): T =>
	context.with(setRootSpan({ context: context.active(), span }), fn);

/** The bound span while it is still open. Nothing is guessed: with none bound, or once it has ended, there is no span to write to. */
export const getRootSpan = (
	activeContext: Context = context.active(),
): Span | undefined => {
	const rootSpan = activeContext.getValue(ROOT_SPAN_CONTEXT_KEY) as
		| Span
		| undefined;
	return rootSpan?.isRecording() ? rootSpan : undefined;
};

/**
 * Stamps what a request or job decided onto its root span. Never throws into
 * the caller; pass a thunk when the attributes take computing.
 */
export const setRootSpanAttributes = (
	attrs: Attributes | (() => Attributes),
) => {
	if (!isMapleEnabled) return;
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
