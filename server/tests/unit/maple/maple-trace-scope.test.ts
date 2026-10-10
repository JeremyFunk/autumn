/**
 * Contract: billing, webhooks and state-changing calls reach Maple whole; reads
 * and the hot path only with scope `api`, sampled at the root but always kept
 * when the request failed, was denied or was slow. Worker jobs follow the same
 * scopes, and a trace sent to Maple can stand in for its request log line.
 */

import { describe, expect, test } from "bun:test";
import {
	type Attributes,
	ROOT_CONTEXT,
	type Span,
	SpanKind,
	SpanStatusCode,
} from "@opentelemetry/api";
import type {
	ReadableSpan,
	SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
	classifyMapleJob,
	classifyMapleRequest,
	getMapleTraceMark,
	isLogReplacedByMapleTrace,
	type MapleTraceMode,
	type MapleTraceScope,
	markTraceForMaple,
	slimMapleLogLine,
} from "@/external/maple/mapleTraceScope.js";
import { JobName } from "@/queue/JobName.js";
import { MapleScopedSpanProcessor } from "@/utils/otel/MapleScopedSpanProcessor.js";
import { getRootSpan, setRootSpan } from "@/utils/otel/rootSpan.js";
import {
	formatTraceparent,
	parseTraceparent,
} from "@/utils/otel/traceparent.js";

const TRACE = "a".repeat(32);
const ROOT = "0000000000000001";

const createSpan = ({
	spanId,
	durationMs = 5,
	statusCode = 200,
	attributes,
}: {
	spanId: string;
	durationMs?: number;
	statusCode?: number;
	attributes?: Attributes;
}): ReadableSpan =>
	({
		name: "span",
		kind: SpanKind.SERVER,
		attributes: { "http.response.status_code": statusCode, ...attributes },
		resource: {} as ReadableSpan["resource"],
		instrumentationScope: { name: "test" },
		status: { code: SpanStatusCode.UNSET },
		events: [],
		links: [],
		startTime: [0, 0],
		endTime: [0, 1],
		duration: [Math.floor(durationMs / 1000), (durationMs % 1000) * 1_000_000],
		ended: true,
		droppedAttributesCount: 0,
		droppedEventsCount: 0,
		droppedLinksCount: 0,
		spanContext: () => ({ traceId: TRACE, spanId, traceFlags: 1 }),
	}) as ReadableSpan;

class CapturingSpanProcessor implements SpanProcessor {
	readonly ended: string[] = [];
	readonly spans: ReadableSpan[] = [];
	onStart(): void {}
	onEnd(span: ReadableSpan): void {
		this.ended.push(span.spanContext().spanId);
		this.spans.push(span);
	}
	forceFlush(): Promise<void> {
		return Promise.resolve();
	}
	shutdown(): Promise<void> {
		return Promise.resolve();
	}
}

const processorFor = ({
	mode,
	sampleRate,
}: {
	mode: MapleTraceMode;
	sampleRate: number;
}) => {
	const marks = new Map([[TRACE, { mode, rootSpanId: ROOT }]]);
	const delegate = new CapturingSpanProcessor();
	const processor = new MapleScopedSpanProcessor(delegate, {
		sampleRate,
		slowMs: 1000,
		marks: {
			get: (traceId) => marks.get(traceId),
			promote: (traceId) => {
				const mark = marks.get(traceId);
				if (mark) mark.mode = "keep";
			},
			unmark: (traceId) => {
				marks.delete(traceId);
			},
		},
	});
	return { processor, delegate };
};

describe("classifyMapleRequest", () => {
	const classify = (
		method: string,
		path: string,
		scope: MapleTraceScope = "writes",
	) => classifyMapleRequest({ method, path, scope });

	test("keeps billing, webhooks and state changes in the default scope", () => {
		for (const path of [
			"/v1/billing.attach",
			"/v1/checkout",
			"/v1/balances.create",
			"/v1/balances.update",
			"/v1/customers.update",
			"/v1/entities.delete",
			"/v1/invoices.finalize",
			"/webhooks/connect/live",
			"/webhooks/revenuecat/org_1/live",
			"/v1/usage",
			"/v1/customers/list_of_things",
			"/checkouts/co_1/confirm",
		]) {
			expect(classify("POST", path)).toBe("keep");
		}
		expect(classify("DELETE", "/v1/customers/cus_1")).toBe("keep");
		// An id that reads like an action is only a read on a POST.
		expect(classify("DELETE", "/v1/customers/list")).toBe("keep");
		expect(classify("PATCH", "/webhooks/vercel/v1/installations/i_1")).toBe(
			"keep",
		);
		expect(classify("GET", "/checkouts/co_1/start")).toBe("keep");
	});

	test("leaves infrastructure and unauthenticated reads alone", () => {
		expect(classify("POST", "/balance-worker-proxy", "api")).toBeNull();
		expect(classify("GET", "/checkouts/co_1", "api")).toBeNull();
		expect(classify("GET", "/webhooks/vercel/v1/installations/i_1")).toBeNull();
	});

	test("keeps a dashboard change only once the caller is known", () => {
		const dashboard = (path: string, isAuthenticated: boolean) =>
			classifyMapleRequest({
				method: "POST",
				path,
				scope: "writes",
				isAuthenticated,
			});
		expect(dashboard("/products/copy_to_production", true)).toBe("keep");
		expect(dashboard("/products/copy_to_production", false)).toBeNull();
		expect(dashboard("/wp-login.php", false)).toBeNull();
		expect(dashboard("/query/events", true)).toBeNull();
		expect(dashboard("/customers/all/full_customers", true)).toBeNull();
		expect(
			classifyMapleRequest({
				method: "POST",
				path: "/products/copy_to_production",
				scope: "billing",
				isAuthenticated: true,
			}),
		).toBeNull();
	});

	test("leaves reads and the hot path out unless the scope is api", () => {
		for (const [method, path] of [
			["POST", "/v1/balances.check"],
			["POST", "/v1/balances.track"],
			["POST", "/v1/customers.get"],
			["POST", "/v1/customers.list"],
			["POST", "/v1/customers.get_or_create"],
			["POST", "/v1/customers"],
			["HEAD", "/v1/customers/cus_1"],
			["POST", "/v1/billing.verify"],
			["POST", "/v1/customers/list"],
			["POST", "/v1/billing.preview_attach"],
			["POST", "/v1/attach/preview"],
			["POST", "/v1/balances.batch_track_tokens"],
			["POST", "/v1/events.aggregate"],
			["POST", "/v1/check"],
			["POST", "/v1/track"],
			["GET", "/v1/customers/cus_1"],
		] as const) {
			expect(classify(method, path)).toBeNull();
			expect(classify(method, path, "api")).toBe("sample");
		}
	});

	test("billing scope matches the log tap only", () => {
		expect(classify("POST", "/v1/attach", "billing")).toBe("keep");
		expect(classify("POST", "/v1/customers.update", "billing")).toBeNull();
	});
});

describe("classifyMapleJob", () => {
	const classify = (jobName: JobName, scope: MapleTraceScope = "writes") =>
		classifyMapleJob({ jobName, scope });

	test("keeps billing jobs in every scope", () => {
		for (const jobName of [
			JobName.AutoTopUp,
			JobName.StripeWebhookReplay,
			JobName.StoreInvoiceLineItems,
			JobName.StoreDeferredInvoiceLineItems,
		]) {
			for (const scope of ["billing", "writes", "api"] as const) {
				expect(classify(jobName, scope)).toBe("keep");
			}
		}
	});

	test("samples hot jobs with scope api and leaves them out otherwise", () => {
		for (const jobName of [
			JobName.Track,
			JobName.InsertEventBatch,
			JobName.SyncBalanceBatchV4,
			JobName.SyncCustomerDirty,
			JobName.PersistPublishedBalanceTransitions,
			JobName.RefreshEntityAggregate,
		]) {
			expect(classify(jobName, "billing")).toBeNull();
			expect(classify(jobName)).toBeNull();
			expect(classify(jobName, "api")).toBe("sample");
		}
	});

	test("keeps every other job unless the scope is billing", () => {
		for (const jobName of [
			JobName.SendProductsUpdated,
			JobName.GrantCheckoutReward,
			JobName.FinalizeLock,
		]) {
			expect(classify(jobName, "billing")).toBeNull();
			expect(classify(jobName)).toBe("keep");
			expect(classify(jobName, "api")).toBe("keep");
		}
	});
});

describe("isLogReplacedByMapleTrace", () => {
	const marked = "b".repeat(32);
	markTraceForMaple({ traceId: marked, rootSpanId: ROOT, mode: "sample" });

	test("replaces the log line of a marked trace that did not fail", () => {
		expect(
			isLogReplacedByMapleTrace({
				traceId: marked,
				failed: false,
				enabled: true,
			}),
		).toBe(true);
	});

	test("keeps the log line when failed, unmarked, untraced or switched off", () => {
		for (const params of [
			{ traceId: marked, failed: true, enabled: true },
			{ traceId: "c".repeat(32), failed: false, enabled: true },
			{ traceId: undefined, failed: false, enabled: true },
			{ traceId: marked, failed: false, enabled: false },
		]) {
			expect(isLogReplacedByMapleTrace(params)).toBe(false);
		}
	});
});

describe("markTraceForMaple", () => {
	test("a kept request joining a sampled trace promotes it and is a root too", () => {
		const traceId = "c".repeat(32);
		markTraceForMaple({ traceId, rootSpanId: "a1", mode: "sample" });
		markTraceForMaple({ traceId, rootSpanId: "b2", mode: "keep" });

		const mark = getMapleTraceMark(traceId);
		expect(mark?.mode).toBe("keep");
		expect(mark?.rootSpanId).toBe("a1");
		expect([...(mark?.rootSpanIds ?? [])]).toEqual(["a1", "b2"]);
	});
});

describe("slimMapleLogLine", () => {
	const fakeSpan = (traceId: string) =>
		({
			isRecording: () => true,
			spanContext: () => ({ traceId, spanId: "s1", traceFlags: 1 }),
		}) as Span;
	const bindings = () => ({
		context: { org_id: "org_1" },
		stripe_event: { id: "evt_1" },
	});
	const slim = (
		args: unknown[],
		level: number,
		traceId: string,
		inRate = true,
	) =>
		slimMapleLogLine({
			args,
			level,
			bindings,
			span: fakeSpan(traceId),
			enabled: true,
			isInSampleRate: () => inRate,
		});

	test("leaves the line alone when off, below info, or outside a marked trace", () => {
		const args = ["cache filled"];
		const span = fakeSpan("e".repeat(32));
		expect(
			slimMapleLogLine({ args, level: 30, bindings, span, enabled: false }),
		).toBeUndefined();
		expect(
			slimMapleLogLine({ args, level: 20, bindings, span, enabled: true }),
		).toBeUndefined();
		expect(slim(args, 30, "e".repeat(32))).toBeUndefined();
	});

	test("an info line loses request and tenant context and keeps the rest", () => {
		const traceId = "1".repeat(32);
		markTraceForMaple({ traceId, rootSpanId: "r1", mode: "keep" });
		const fields = { req: { id: "req_1" }, plan: "pro" };

		expect(slim([fields, "attached"], 30, traceId)).toEqual({
			slimmed: true,
			args: [
				{
					stripe_event: { id: "evt_1" },
					plan: "pro",
					trace_id: traceId,
					span_id: "s1",
				},
				"attached",
			],
		});
		// The caller's object is not touched.
		expect(fields.req).toEqual({ id: "req_1" });
		expect(slim(["attached"], 30, traceId)).toEqual({
			slimmed: true,
			args: [
				{ stripe_event: { id: "evt_1" }, trace_id: traceId, span_id: "s1" },
				"attached",
			],
		});
	});

	test("a warning only gains the span ids", () => {
		const traceId = "2".repeat(32);
		markTraceForMaple({ traceId, rootSpanId: "r1", mode: "sample" });

		expect(
			slim([{ req: { id: "req_1" } }, "cache incomplete"], 40, traceId, false),
		).toEqual({
			slimmed: false,
			args: [
				{ req: { id: "req_1" }, trace_id: traceId, span_id: "s1" },
				"cache incomplete",
			],
		});
	});

	test("an info line of a sampled trace follows the sample rate", () => {
		const traceId = "3".repeat(32);
		markTraceForMaple({ traceId, rootSpanId: "r1", mode: "sample" });

		expect(slim(["cache filled"], 30, traceId, false)).toBe("drop");
		expect(slim(["cache filled"], 30, traceId, true)).toMatchObject({
			slimmed: true,
		});
	});
});

describe("getRootSpan", () => {
	const fakeSpan = (recording: boolean) =>
		({ isRecording: () => recording }) as Span;

	test("returns the bound span only while it is open, and never guesses", () => {
		const bound = (span: Span) =>
			getRootSpan(setRootSpan({ context: ROOT_CONTEXT, span }));

		expect(getRootSpan(ROOT_CONTEXT)).toBeUndefined();
		const open = fakeSpan(true);
		expect(bound(open)).toBe(open);
		expect(bound(fakeSpan(false))).toBeUndefined();
	});
});

describe("traceparent", () => {
	test("round-trips a span context as a remote parent", () => {
		const traceparent = formatTraceparent({
			spanContext: { traceId: TRACE, spanId: ROOT, traceFlags: 1 },
		});
		expect(traceparent).toBe(`00-${TRACE}-${ROOT}-01`);
		expect(parseTraceparent({ traceparent })).toEqual({
			traceId: TRACE,
			spanId: ROOT,
			traceFlags: 1,
			isRemote: true,
		});
	});

	test("ignores a value that is not a usable parent", () => {
		for (const traceparent of [
			42,
			{ a: 1 },
			`00-${"0".repeat(32)}-${"1".repeat(16)}-01`,
			`00-${"a".repeat(32)}-${"0".repeat(16)}-01`,
		]) {
			expect(
				parseTraceparent({ traceparent: traceparent as string }),
			).toBeUndefined();
		}
	});

	test("ignores a missing or malformed header", () => {
		expect(parseTraceparent({})).toBeUndefined();
		expect(parseTraceparent({ traceparent: "00-abc-def-01" })).toBeUndefined();
	});
});

describe("MapleScopedSpanProcessor", () => {
	test("forwards kept traces as spans end", () => {
		const { processor, delegate } = processorFor({
			mode: "keep",
			sampleRate: 0,
		});
		processor.onEnd(createSpan({ spanId: "0000000000000002" }));
		processor.onEnd(createSpan({ spanId: ROOT }));
		expect(delegate.ended).toEqual(["0000000000000002", ROOT]);
	});

	test("drops a sampled-out trace once its root ends", () => {
		const { processor, delegate } = processorFor({
			mode: "sample",
			sampleRate: 0,
		});
		processor.onEnd(createSpan({ spanId: "0000000000000002" }));
		processor.onEnd(createSpan({ spanId: ROOT }));
		processor.onEnd(createSpan({ spanId: "0000000000000003" }));
		expect(delegate.ended).toEqual([]);
	});

	test("keeps a sampled trace whose root failed or was slow, children first", () => {
		for (const root of [
			createSpan({ spanId: ROOT, statusCode: 503 }),
			createSpan({ spanId: ROOT, durationMs: 2500 }),
		]) {
			const { processor, delegate } = processorFor({
				mode: "sample",
				sampleRate: 0,
			});
			processor.onEnd(createSpan({ spanId: "0000000000000002" }));
			processor.onEnd(root);
			processor.onEnd(createSpan({ spanId: "0000000000000003" }));
			expect(delegate.ended).toEqual([
				"0000000000000002",
				ROOT,
				"0000000000000003",
			]);
		}
	});

	test("keeps a sampled trace whose root was a client error or a denial", () => {
		for (const root of [
			createSpan({ spanId: ROOT, statusCode: 404 }),
			createSpan({ spanId: ROOT, attributes: { "maple.keep": true } }),
		]) {
			const { processor, delegate } = processorFor({
				mode: "sample",
				sampleRate: 0,
			});
			processor.onEnd(createSpan({ spanId: "0000000000000002" }));
			processor.onEnd(root);
			expect(delegate.ended).toEqual(["0000000000000002", ROOT]);
		}
	});

	test("sends child spans without the tenant attrs the root carries", () => {
		const tenant = { org_id: "org_1", customer_id: "cus_1" };
		for (const mode of ["keep", "sample"] as const) {
			const { processor, delegate } = processorFor({ mode, sampleRate: 1 });
			processor.onEnd(
				createSpan({
					spanId: "0000000000000002",
					attributes: { ...tenant, "db.system": "postgresql" },
				}),
			);
			processor.onEnd(createSpan({ spanId: ROOT, attributes: tenant }));

			const [child, root] = delegate.spans;
			expect(child.attributes).toEqual({
				"http.response.status_code": 200,
				"db.system": "postgresql",
			});
			expect(root.attributes).toMatchObject(tenant);
		}
	});

	test("a second request under the same trace id keeps its tenant attrs and promotes the trace", () => {
		const SECOND = "0000000000000009";
		const tenant = { org_id: "org_1" };
		const marks = new Map([
			[
				TRACE,
				{
					mode: "sample" as MapleTraceMode,
					rootSpanId: ROOT,
					rootSpanIds: new Set([ROOT, SECOND]),
				},
			],
		]);
		const delegate = new CapturingSpanProcessor();
		const processor = new MapleScopedSpanProcessor(delegate, {
			sampleRate: 0,
			slowMs: 1000,
			marks: {
				get: (traceId) => marks.get(traceId),
				promote: () => {},
				unmark: (traceId) => {
					marks.delete(traceId);
				},
			},
		});

		// A child of the sampled first request waits for its verdict.
		processor.onEnd(createSpan({ spanId: "0000000000000002" }));
		expect(delegate.ended).toEqual([]);

		// The second request is a state change: the mark becomes keep.
		const mark = marks.get(TRACE);
		if (mark) mark.mode = "keep";
		processor.onEnd(createSpan({ spanId: SECOND, attributes: tenant }));

		expect(delegate.ended).toEqual(["0000000000000002", SECOND]);
		expect(delegate.spans[1].attributes).toMatchObject(tenant);
	});

	test("a request that must be kept is, whichever request of the trace ends first", () => {
		const SECOND = "0000000000000009";
		const setup = () => {
			const marks = new Map([
				[
					TRACE,
					{
						mode: "sample" as MapleTraceMode,
						rootSpanId: ROOT,
						rootSpanIds: new Set([ROOT, SECOND]),
					},
				],
			]);
			const delegate = new CapturingSpanProcessor();
			const processor = new MapleScopedSpanProcessor(delegate, {
				sampleRate: 0,
				slowMs: 1000,
				marks: {
					get: (traceId) => marks.get(traceId),
					promote: (traceId) => {
						const mark = marks.get(traceId);
						if (mark) mark.mode = "keep";
					},
					unmark: (traceId) => {
						marks.delete(traceId);
					},
				},
			});
			return { marks, delegate, processor };
		};

		// The healthy first request ends before the failed second one.
		const first = setup();
		first.processor.onEnd(createSpan({ spanId: ROOT }));
		expect(first.delegate.ended).toEqual([]);
		first.processor.onEnd(createSpan({ spanId: SECOND, statusCode: 404 }));
		expect(first.delegate.ended).toEqual([ROOT, SECOND]);

		// The failed second request ends first.
		const second = setup();
		second.processor.onEnd(createSpan({ spanId: SECOND, statusCode: 404 }));
		second.processor.onEnd(createSpan({ spanId: ROOT }));
		expect(second.delegate.ended).toEqual([SECOND, ROOT]);

		// Both healthy and out of the rate: nothing is exported, nothing lingers.
		const neither = setup();
		neither.processor.onEnd(createSpan({ spanId: SECOND }));
		neither.processor.onEnd(createSpan({ spanId: ROOT }));
		expect(neither.delegate.ended).toEqual([]);
		expect(neither.marks.has(TRACE)).toBe(false);
	});

	test("a rate-limited request is sampled like a healthy one", () => {
		const { processor, delegate } = processorFor({
			mode: "sample",
			sampleRate: 0,
		});
		processor.onEnd(createSpan({ spanId: ROOT, statusCode: 429 }));
		expect(delegate.ended).toEqual([]);
	});

	test("keeps a healthy sampled trace that falls in the rate", () => {
		const { processor, delegate } = processorFor({
			mode: "sample",
			sampleRate: 1,
		});
		processor.onEnd(createSpan({ spanId: ROOT }));
		expect(delegate.ended).toEqual([ROOT]);
	});
});
