import { stripVTControlCharacters } from "node:util";
import { context, trace } from "@opentelemetry/api";
import type { MiddlewareHandler } from "hono";
import { JobName } from "@/queue/JobName.js";
import { getRootSpan, withRootSpan } from "@/utils/otel/rootSpan.js";
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

// The hot path: called per usage event, and recorded in the events table anyway.
const HOT_ACTIONS = new Set(["check", "track", "batch_track", "track_tokens"]);
const HOT_LEGACY_SEGMENTS = new Set([
	"check",
	"entitled",
	"track",
	"track_tokens",
	"usage",
	"events",
	"query",
]);

// The queue's side of the hot path: one message per usage event or balance sync.
const HOT_JOBS = new Set<string>([
	JobName.Track,
	JobName.InsertEventBatch,
	JobName.SyncBalanceBatchV4,
	JobName.SyncCustomerDirty,
	JobName.PersistPublishedBalanceTransitions,
	JobName.RefreshEntityAggregate,
	JobName.UpdateUsage,
	JobName.UpdateBalance,
]);
// What a billing request or Stripe webhook leaves for the worker to finish.
const BILLING_JOBS = new Set<string>([
	JobName.AutoTopUp,
	JobName.StripeWebhookReplay,
	JobName.StoreInvoiceLineItems,
	JobName.StoreDeferredInvoiceLineItems,
]);

const isReadAction = (action: string) =>
	action === "get" ||
	action.startsWith("get_") ||
	action.startsWith("list") ||
	action.startsWith("preview");

const parseScope = (value: string | undefined): MapleTraceScope =>
	value === "billing" || value === "api" ? value : "writes";

const MAPLE_TRACE_SCOPE = parseScope(process.env.MAPLE_TRACE_SCOPE);

/**
 * Billing requests, webhooks and every state-changing /v1 call are kept whole,
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
	if (method === "POST" && WEBHOOK_PREFIXES.some((p) => path.startsWith(p)))
		return "keep";
	if (!path.startsWith("/v1/")) return null;

	const rest = path.slice("/v1/".length);
	const isBilling =
		method === "POST" && BILLING_PATHS.some((p) => rest.startsWith(p));
	if (isBilling) return "keep";
	if (scope === "billing") return null;

	const segment = rest.split("/")[0] ?? "";
	const dot = segment.indexOf(".");
	const isHotOrRead =
		dot === -1
			? method === "GET" || HOT_LEGACY_SEGMENTS.has(segment)
			: HOT_ACTIONS.has(segment.slice(dot + 1)) ||
				isReadAction(segment.slice(dot + 1));

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
const MAX_MARKED_TRACES = 10_000;
const marks = new Map<string, { mode: MapleTraceMode; rootSpanId: string }>();

export const markTraceForMaple = ({
	traceId,
	rootSpanId,
	mode,
}: {
	traceId: string;
	rootSpanId: string;
	mode: MapleTraceMode;
}) => {
	if (marks.has(traceId)) return;
	if (marks.size >= MAX_MARKED_TRACES) {
		const oldest = marks.keys().next().value;
		if (oldest !== undefined) marks.delete(oldest);
	}
	marks.set(traceId, { mode, rootSpanId });
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
 * Binds it for every request, whatever the mode, so handlers can stamp it.
 */
export const mapleTraceScopeMiddleware: MiddlewareHandler = (c, next) => {
	const span = trace.getSpan(context.active());
	if (!span) return next();

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
	const mode = isContinued ? "keep" : classifyMapleJob({ jobName });
	if (!span || !mode) return;

	const { traceId, spanId } = span.spanContext();
	markTraceForMaple({ traceId, rootSpanId: spanId, mode });
};

const REPLACE_REQUEST_LOGS =
	Boolean(process.env.MAPLE_INGEST_KEY) &&
	process.env.MAPLE_REPLACE_REQUEST_LOGS === "true";

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
const MAX_LOG_EVENT_NAME_LENGTH = 300;

/**
 * An info line logged under a trace going to Maple becomes an event on that
 * trace instead: the request context is stated once on the root span rather
 * than repeated on every line, and the breadcrumb is sampled with its trace.
 * Returns true when the line was recorded and should not be logged.
 */
export const recordLogAsMapleSpanEvent = ({
	args,
	level,
	enabled = REPLACE_REQUEST_LOGS,
}: {
	args: unknown[];
	level: number;
	enabled?: boolean;
}): boolean => {
	if (!enabled || level !== PINO_INFO_LEVEL) return false;
	try {
		const span = trace.getActiveSpan();
		if (!span || !getMapleTraceMark(span.spanContext().traceId)) return false;

		const message = args.find((arg) => typeof arg === "string");
		const target = span.isRecording() ? span : getRootSpan();
		if (message === undefined || !target) return false;
		target.addEvent(
			stripVTControlCharacters(message).slice(0, MAX_LOG_EVENT_NAME_LENGTH),
		);
		return true;
	} catch {
		return false;
	}
};
