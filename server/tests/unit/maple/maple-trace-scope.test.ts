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
	isLogReplacedByMapleTrace,
	type MapleTraceMode,
	type MapleTraceScope,
	markTraceForMaple,
	recordLogAsMapleSpanEvent,
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
			"/v1/billing.preview_attach",
			"/v1/balances.create",
			"/v1/balances.update",
			"/v1/customers",
			"/v1/customers.update",
			"/v1/entities.delete",
			"/v1/invoices.finalize",
			"/webhooks/connect/live",
			"/webhooks/revenuecat/org_1/live",
		]) {
			expect(classify("POST", path)).toBe("keep");
		}
		expect(classify("DELETE", "/v1/customers/cus_1")).toBe("keep");
	});

	test("leaves reads and the hot path out unless the scope is api", () => {
		for (const [method, path] of [
			["POST", "/v1/balances.check"],
			["POST", "/v1/balances.track"],
			["POST", "/v1/customers.get"],
			["POST", "/v1/customers.list"],
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
			JobName.UpdateUsage,
			JobName.UpdateBalance,
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

describe("recordLogAsMapleSpanEvent", () => {
	test("leaves the line to the logger when off, not info, or outside a trace", () => {
		const args = ["cache filled"];
		expect(recordLogAsMapleSpanEvent({ args, level: 30, enabled: false })).toBe(
			false,
		);
		expect(recordLogAsMapleSpanEvent({ args, level: 40, enabled: true })).toBe(
			false,
		);
		expect(recordLogAsMapleSpanEvent({ args, level: 30, enabled: true })).toBe(
			false,
		);
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

	test("keeps a healthy sampled trace that falls in the rate", () => {
		const { processor, delegate } = processorFor({
			mode: "sample",
			sampleRate: 1,
		});
		processor.onEnd(createSpan({ spanId: ROOT }));
		expect(delegate.ended).toEqual([ROOT]);
	});
});
