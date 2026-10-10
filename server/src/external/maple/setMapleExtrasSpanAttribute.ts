import { maskExtraLogs } from "@/utils/logging/maskExtraLogs.js";
import { setRootSpanAttributes } from "@/utils/otel/rootSpan.js";

const MAX_EXTRAS_ATTR_LENGTH = 2048;

/** What the dropped summary line carried under `extras`, on the span standing in for it. */
export const setMapleExtrasSpanAttribute = ({
	extraLogs,
}: {
	extraLogs: Record<string, unknown> | undefined;
}) => {
	if (!extraLogs || Object.keys(extraLogs).length === 0) return;
	setRootSpanAttributes(() => ({
		"autumn.extras": JSON.stringify(maskExtraLogs(extraLogs)).slice(
			0,
			MAX_EXTRAS_ATTR_LENGTH,
		),
	}));
};
