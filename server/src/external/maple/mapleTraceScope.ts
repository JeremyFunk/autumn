import { context, trace } from "@opentelemetry/api";
import type { MiddlewareHandler } from "hono";
import { JobName } from "@/queue/JobName.js";
import { withRootSpan } from "@/utils/otel/rootSpan.js";
import { isMapleEnabled } from "./mapleEnabled.js";
import { isInMapleSampleRate } from "./mapleSampling.js";
import { BILLING_PATHS } from "./parseMapleLog.js";

/** `keep` exports the whole trace; `sample` keeps errors, slow roots and a share of the rest. */
export type MapleTraceMode = "keep" | "sample";
export type MapleTraceScope = "billing" | "writes" | "api";

const WEBHOOK_PREFIXES = [
	"/webhooks/stripe/",
	"/webhooks/connect/",
	"/webhooks/revenuecat/",
	"/webhooks/vercel/",
];

// Infrastructure endpoints that are neither customer state nor investigations.
const UNTRACED_PREFIXES = ["/balance-worker-proxy", "/atom/"];

// The hot path: called per usage event, and recorded in the events table anyway.
const HOT_ACTIONS = new Set([
	"check",
	"track",
	"batch_track",
	"track_tokens",
	"batch_track_tokens",
]);
const HOT_LEGACY_SEGMENTS = new Set([
	"check",
	"entitled",
	"track",
	"track_tokens",
	"events",
	"query",
]);

// The queue's side of the hot path: one message per usage event or balance sync.
// UpdateBalance and UpdateUsage are not here: they apply a requested change.
const HOT_JOBS = new Set<string>([
	JobName.Track,
	JobName.InsertEventBatch,
	JobName.SyncBalanceBatchV4,
	JobName.SyncCustomerDirty,
	JobName.PersistPublishedBalanceTransitions,
	JobName.RefreshEntityAggregate,
]);
// What a billing request or Stripe webhook leaves for the worker to finish.
const BILLING_JOBS = new Set<string>([
	JobName.AutoTopUp,
	JobName.StripeWebhookReplay,
	JobName.StoreInvoiceLineItems,
	JobName.StoreDeferredInvoiceLineItems,
]);

// `get_or_create` reads like a read but creates the customer and attaches defaults.
const WRITE_ACTIONS = new Set(["get_or_create"]);
const READ_ACTIONS = new Set([
	"get",
	"aggregate",
	"search",
	"query",
	"has_customers",
]);

const isReadAction = (action: string) =>
	!WRITE_ACTIONS.has(action) &&
	(READ_ACTIONS.has(action) ||
		action.startsWith("get_") ||
		action.startsWith("list") ||
		action.startsWith("preview"));

// Legacy paths end in an id as often as in an action, so only exact names count.
const LEGACY_READ_TAILS = new Set([
	"list",
	"preview",
	"preview_recalculate",
	"search",
	"query",
	"has_customers",
]);

/** Whether a path names a read: `billing.preview_attach`, `customers.get`, `attach/preview`. */
const isReadPath = (rest: string) => {
	const [segment = "", ...tail] = rest.split("/");
	const dot = segment.lastIndexOf(".");
	return dot === -1
		? LEGACY_READ_TAILS.has(tail.at(-1) ?? "")
		: isReadAction(segment.slice(dot + 1));
};

const parseScope = (value: string | undefined): MapleTraceScope =>
	value === "billing" || value === "api" ? value : "writes";

const MAPLE_TRACE_SCOPE = parseScope(process.env.MAPLE_TRACE_SCOPE);

/**
 * Billing requests, webhooks and every state-changing call are kept whole,
 * since they answer "why is this customer in this state". Reads and the hot
 * path are sampled, and only traced at all with scope `api`.
 */
export const classifyMapleRequest = ({
	method,
	path,
	scope = MAPLE_TRACE_SCOPE,
}: {
	method: string;
	path: string;
	scope?: MapleTraceScope;
}): MapleTraceMode | null => {
	const isWrite = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
	if (isWrite && WEBHOOK_PREFIXES.some((p) => path.startsWith(p)))
		return "keep";

	if (!path.startsWith("/v1/")) {
		if (UNTRACED_PREFIXES.some((p) => path.startsWith(p))) return null;
		// Hosted checkout: confirm, and the GET that starts a long-lived one, attach a plan.
		if (
			path.startsWith("/checkouts/") &&
			(path.endsWith("/confirm") || path.endsWith("/start"))
		)
			return "keep";
		// Dashboard, CLI and admin changes.
		if (scope === "billing" || !isWrite) return null;
		return isReadPath(path.slice(1)) ? null : "keep";
	}

	const rest = path.slice("/v1/".length);
	const isRead = isReadPath(rest);
	const isBilling =
		method === "POST" &&
		!isRead &&
		BILLING_PATHS.some((p) => rest.startsWith(p));
	if (isBilling) return "keep";
	if (scope === "billing") return null;

	const segment = rest.split("/")[0] ?? "";
	const dot = segment.lastIndexOf(".");
	const isHotOrRead =
		isRead ||
		(dot === -1
			? method === "GET" || HOT_LEGACY_SEGMENTS.has(segment)
			: HOT_ACTIONS.has(segment.slice(dot + 1)));

	if (!isHotOrRead) return "keep";
	return scope === "api" ? "sample" : null;
};

/** Worker jobs follow the request scopes: billing jobs always, hot jobs sampled with scope `api`, the rest unless the scope is `billing`. */
export const classifyMapleJob = ({
	jobName,
	scope = MAPLE_TRACE_SCOPE,
}: {
	jobName: string;
	scope?: MapleTraceScope;
}): MapleTraceMode | null => {
	if (BILLING_JOBS.has(jobName)) return "keep";
	if (HOT_JOBS.has(jobName)) return scope === "api" ? "sample" : null;
	return scope === "billing" ? null : "keep";
};

// Stripe webhooks keep working after the early ack ends the root span, so
// marks are never cleared on root end; FIFO eviction bounds memory instead.
// Sized so a mark outlives its trace at a few hundred kept traces a second.
const MAX_MARKED_TRACES = 50_000;

type MapleTraceMark = {
	mode: MapleTraceMode;
	/** Decides a sampled trace when it ends. */
	rootSpanId: string;
	/** Every request or job span of the trace: a client can send several requests under one trace id. */
	rootSpanIds: Set<string>;
};
const marks = new Map<string, MapleTraceMark>();

export const markTraceForMaple = ({
	traceId,
	rootSpanId,
	mode,
}: {
	traceId: string;
	rootSpanId: string;
	mode: MapleTraceMode;
}) => {
	const existing = marks.get(traceId);
	if (existing) {
		existing.rootSpanIds.add(rootSpanId);
		if (mode === "keep") existing.mode = "keep";
		return;
	}
	if (marks.size >= MAX_MARKED_TRACES) {
		const oldest = marks.keys().next().value;
		if (oldest !== undefined) marks.delete(oldest);
	}
	marks.set(traceId, { mode, rootSpanId, rootSpanIds: new Set([rootSpanId]) });
};

export const getMapleTraceMark = (traceId: string) => marks.get(traceId);

export const promoteMapleTrace = (traceId: string) => {
	const mark = marks.get(traceId);
	if (mark) mark.mode = "keep";
};

export const unmarkMapleTrace = (traceId: string) => {
	marks.delete(traceId);
};

/**
 * Must run right after the OTel HTTP middleware, so the root span is active.
 * Does nothing without a Maple key. A span that is not recording (the caller
 * sent an unsampled traceparent) is never marked: nothing would be exported,
 * so nothing may stand in for its logs.
 */
export const mapleTraceScopeMiddleware: MiddlewareHandler = (c, next) => {
	const span = trace.getSpan(context.active());
	if (!isMapleEnabled || !span?.isRecording()) return next();

	const mode = classifyMapleRequest({ method: c.req.method, path: c.req.path });
	if (mode) {
		const { traceId, spanId } = span.spanContext();
		markTraceForMaple({ traceId, rootSpanId: spanId, mode });
	}
	return withRootSpan({ span, fn: next });
};

/** Marks the active worker span's trace. A job continuing a request's trace is kept, since only kept traces propagate. */
export const markJobTraceForMaple = ({
	jobName,
	isContinued,
}: {
	jobName: string;
	isContinued: boolean;
}) => {
	const span = trace.getSpan(context.active());
	if (!isMapleEnabled || !span?.isRecording()) return;
	const mode = isContinued ? "keep" : classifyMapleJob({ jobName });
	if (!mode) return;

	const { traceId, spanId } = span.spanContext();
	markTraceForMaple({ traceId, rootSpanId: spanId, mode });
};

const REPLACE_REQUEST_LOGS =
	isMapleEnabled && process.env.MAPLE_REPLACE_REQUEST_LOGS === "true";

/** True when the trace sent to Maple stands in for a request or job log line. Failures always log. */
export const isLogReplacedByMapleTrace = ({
	traceId,
	failed,
	enabled = REPLACE_REQUEST_LOGS,
}: {
	traceId: string | undefined;
	failed: boolean;
	enabled?: boolean;
}) =>
	enabled &&
	!failed &&
	traceId !== undefined &&
	getMapleTraceMark(traceId) !== undefined;

const PINO_INFO_LEVEL = 30;

/**
 * An info line logged under a trace going to Maple is slimmed, not dropped:
 * it keeps its message and fields and gains the ids of the span it was logged
 * under, and loses the request and tenant bindings the root span already
 * states once. Lines of a sampled trace follow the trace's sample rate.
 *
 * Returns the line to write without bindings, "drop", or undefined to leave
 * the line as it is.
 */
export const slimMapleLogLine = ({
	args,
	level,
	enabled = REPLACE_REQUEST_LOGS,
}: {
	args: unknown[];
	level: number;
	enabled?: boolean;
}): [Record<string, unknown>, ...unknown[]] | "drop" | undefined => {
	if (!enabled || level !== PINO_INFO_LEVEL) return undefined;
	try {
		const span = trace.getActiveSpan();
		if (!span) return undefined;
		const { traceId, spanId } = span.spanContext();
		const mark = getMapleTraceMark(traceId);
		if (!mark) return undefined;
		if (mark.mode === "sample" && !isInMapleSampleRate({ traceId }))
			return "drop";

		const [first, ...rest] = args;
		const ids = { trace_id: traceId, span_id: spanId };
		return first !== null && typeof first === "object"
			? [{ ...first, ...ids }, ...rest]
			: [ids, ...args];
	} catch {
		return undefined;
	}
};
