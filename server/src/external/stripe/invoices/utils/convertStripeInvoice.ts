import type Stripe from "stripe";
import { getStripeInvoice } from "@/external/stripe/invoices/operations/getStripeInvoice";

export const stripeInvoiceToStripeSubscriptionId = (
	stripeInvoice: Stripe.Invoice,
) => {
	const subId = stripeInvoice.parent?.subscription_details?.subscription;
	return subId as string | undefined;
};

/** An invoice's id, status and total (in the currency's minor unit), as span attributes. */
export const stripeInvoiceToSpanAttributes = (
	stripeInvoice: Stripe.Invoice | undefined,
) => ({
	"stripe.invoice_id": stripeInvoice?.id,
	"stripe.invoice_status": stripeInvoice?.status ?? undefined,
	"stripe.invoice_amount": stripeInvoice?.total,
	"stripe.invoice_currency": stripeInvoice?.currency,
});

/**
 * Finds the payment intent from a specific invoice.
 */
export const stripeInvoiceIdToPaymentIntent = async ({
	stripeClient,
	invoiceId,
}: {
	stripeClient: Stripe;
	invoiceId: string;
}): Promise<string | null> => {
	const invoice = await getStripeInvoice({
		stripeClient,
		invoiceId,
		expand: ["payments.data.payment.payment_intent"],
	});

	const firstPayment = invoice.payments?.data?.[0];
	const payment = firstPayment?.payment;
	return payment?.payment_intent.id ?? null;
};
