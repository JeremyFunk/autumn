import Stripe from "stripe";

/**
 * DEMO ONLY (not part of the Maple PR). With STRIPE_STUB_URL set, Stripe SDK
 * requests are rewritten to a local stand-in, since no Stripe key exists in the
 * local demo. The SDK still believes it talks to api.stripe.com, so spans carry
 * the same `server.address` they would in production.
 */
export const stripeStubConfig = (): Stripe.StripeConfig => {
	const stubUrl = process.env.STRIPE_STUB_URL;
	if (!stubUrl) return {};

	const stub = new URL(stubUrl);
	return {
		maxNetworkRetries: 0,
		httpClient: Stripe.createFetchHttpClient(((
			input: string | URL,
			init?: RequestInit,
		) => {
			const url = new URL(String(input));
			url.protocol = stub.protocol;
			url.host = stub.host;
			return fetch(url, init);
		}) as typeof fetch),
	};
};
