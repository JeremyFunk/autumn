import { RecaseError } from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import type { ExpireLockReceiptPayload } from "@/queue/workflows.js";
import { setRootSpanAttributes } from "@/utils/otel/rootSpan.js";
import { runFinalizeLock } from "./runFinalizeLock.js";

export const expireLock = async ({
	ctx,
	payload,
}: {
	ctx: AutumnContext;
	payload: ExpireLockReceiptPayload;
}) => {
	// "released" stands unless the lock is already gone.
	setRootSpanAttributes({
		"balance.action": "expire_lock",
		"lock.id": payload.lockId,
		"lock.outcome": "released",
	});

	try {
		ctx.skipCache = false;
		await runFinalizeLock({
			ctx,
			params: {
				lock_id: payload.lockId,
				action: "release",
				override_value: 0,
			},
		});
	} catch (error) {
		if (
			error instanceof RecaseError &&
			error.message.includes("Lock not found")
		) {
			setRootSpanAttributes({ "lock.outcome": "not_found" });
			return;
		}
		throw error;
	}
};
