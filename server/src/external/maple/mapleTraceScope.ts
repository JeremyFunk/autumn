import { context, type Span, trace } from "@opentelemetry/api";
import type { MiddlewareHandler } from "hono";
import { JobName } from "@/queue/JobName.js";
import { getRootSpan, withRootSpan } from "@/utils/otel/rootSpan.js";
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

// Reads whose name does not say so. `get_or_create` counts as one: when it
// does create a customer, the handler asks for the trace to be kept.
const READ_ACTIONS = new Set([
	"get",
	"aggregate",
	"search",
	"query",
	"has_customers",
	"verify",
	"resolve_request",
	"sync_proposals",
	"sync_proposals_v2",
	"revenuecat_mappings",
	"diff",
	"customer_counts",
	"search_endpoints",
]);

const isReadAction = (action: string) =>
	READ_ACTIONS.has(action) ||
	action.startsWith("get_") ||
	action.startsWith("list") ||
	action.startsWith("preview");

// Dashboard reads that are sent as POST.
const DASHBOARD_READ_PREFIXES = ["/query/", "/workbench/", "/trmnl/"];

// Legacy paths end in an id as often as in an action, so only exact names count.
const LEGACY_READ_TAILS = new Set([
	"list",
	"preview",
	"preview_recalculate",
	"search",
	"query",
	"has_customers",
	"full_customers",
	"count",
	"onboardingStatus",
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
	isAuthenticated = false,
}: {
	method: string;
	path: string;
	scope?: MapleTraceScope;
	/** Dashboard, CLI and admin changes are only kept once the caller is known, so a POST to a made-up path is not. */
	isAuthenticated?: boolean;
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
		if (scope === "billing" || !isWrite || !isAuthenticated) return null;
		if (DASHBOARD_READ_PREFIXES.some((p) => path.startsWith(p))) return null;
		return method === "POST" && isReadPath(path.slice(1)) ? null : "keep";
	}

	const rest = path.slice("/v1/".length);
	// Only a POST can be a read by name; PUT, PATCH and DELETE never are.
	const isRead = method === "POST" && isReadPath(rest);
	const isBilling =
		method === "POST" &&
		!isRead &&
		BILLING_PATHS.some((p) => rest.startsWith(p));
	if (isBilling) return "keep";
	if (scope === "billing") return null;

	const segment = rest.split("/")[0] ?? "";
	const dot = segment.lastIndexOf(".");
	const isHotOrRead =
		!isWrite ||
		isRead ||
		// Legacy identify: creates the customer only the first time.
		(method === "POST" && rest === "customers") ||
		(dot === -1
			? HOT_LEGACY_SEGMENTS.has(segment)
			: HOT_ACTIONS.has(segment.slice(dot + 1)));

	if (!isHotOrRead) return "keep";
	return scope === "api" ? "sample" : null;
};

/** Batch and per-event jobs are sent from timers that outlive the request that armed them, so they never join a request's trace. */
export const isHotMapleJob = (jobName: string) => HOT_JOBS.has(jobName);

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

/**
 * Marks a request whose caller is now known. Runs after auth, where the
 * dashboard, CLI and admin routes that the first pass leaves alone are decided.
 */
export const markAuthenticatedRequestForMaple = ({
	method,
	path,
}: {
	method: string;
	path: string;
}) => {
	if (!isMapleEnabled) return;
	const span = getRootSpan();
	if (!span) return;
	const mode = classifyMapleRequest({ method, path, isAuthenticated: true });
	if (!mode) return;

	const { traceId, spanId } = span.spanContext();
	markTraceForMaple({ traceId, rootSpanId: spanId, mode });
};

/** A further span that carries tenant attrs in a trace already going to Maple, e.g. the deferred half of an early-acked webhook. */
export const addMapleTraceRoot = (span: Span) => {
	const { traceId, spanId } = span.spanContext();
	getMapleTraceMark(traceId)?.rootSpanIds.add(spanId);
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

/** Whether a trace sent to Maple stands in for log lines at all. */
export const isMapleLogReplacementEnabled =
	isMapleEnabled && process.env.MAPLE_REPLACE_REQUEST_LOGS === "true";

/** True when the trace sent to Maple stands in for a request or job log line. Failures always log. */
export const isLogReplacedByMapleTrace = ({
	traceId,
	failed,
	enabled = isMapleLogReplacementEnabled,
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

type LogArgs = [Record<string, unknown>, ...unknown[]];

/**
 * A line logged under a trace going to Maple gains the ids of the span it was
 * logged under. An info line is also slimmed: it loses the request and tenant
 * context the root span already states once, and for a sampled trace it
 * follows the trace's sample rate. Warnings and errors keep everything.
 *
 * `bindings` are the logger's own: a slimmed line is written through the root
 * logger with the bindings it keeps. Returns "drop", or undefined to leave the
 * line as it is.
 */
export const slimMapleLogLine = ({
	args,
	level,
	bindings,
	span = trace.getActiveSpan(),
	enabled = isMapleLogReplacementEnabled,
	isInSampleRate = isInMapleSampleRate,
}: {
	args: unknown[];
	level: number;
	bindings: () => Record<string, unknown>;
	span?: Span;
	enabled?: boolean;
	isInSampleRate?: (args: { traceId: string }) => boolean;
}): { args: LogArgs; slimmed: boolean } | "drop" | undefined => {
	if (!enabled || level < PINO_INFO_LEVEL || !span?.isRecording())
		return undefined;
	try {
		const { traceId, spanId } = span.spanContext();
		const mark = getMapleTraceMark(traceId);
		if (!mark) return undefined;

		const [first, ...rest] = args;
		const hasFields = first !== null && typeof first === "object";
		const fields = hasFields ? (first as Record<string, unknown>) : {};
		const tail = hasFields ? rest : args;
		const ids = { trace_id: traceId, span_id: spanId };
		if (level > PINO_INFO_LEVEL)
			return { args: [{ ...fields, ...ids }, ...tail], slimmed: false };

		if (mark.mode === "sample" && !isInSampleRate({ traceId })) return "drop";
		// `req` rides on the line's fields and `context` on the logger's bindings.
		const { req: _req, ...ownFields } = fields;
		const { context: _context, ...ownBindings } = bindings();
		return {
			args: [{ ...ownBindings, ...ownFields, ...ids }, ...tail],
			slimmed: true,
		};
	} catch {
		return undefined;
	}
};
