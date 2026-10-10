import { type Attributes, SpanKind, trace } from "@opentelemetry/api";
import { isMapleEnabled } from "@/external/maple/mapleEnabled.js";
import { getMapleTraceMark } from "@/external/maple/mapleTraceScope.js";
import { withActiveSpan } from "./withActiveSpan.js";

/**
 * Span around one outbound dependency call. Only traces going to Maple get
 * it, so nothing is added to the hot path or to the trace stream otherwise.
 */
export const withDependencySpan = async <T>({
	name,
	kind = SpanKind.CLIENT,
	attributes,
	fn,
}: {
	name: string;
	kind?: SpanKind;
	attributes?: Attributes;
	fn: () => Promise<T>;
}): Promise<T> => {
	if (!isMapleEnabled) return fn();
	const traceId = trace.getActiveSpan()?.spanContext().traceId;
	if (!traceId || !getMapleTraceMark(traceId)) return fn();
	return withActiveSpan({ name, kind, attributes, fn });
};
