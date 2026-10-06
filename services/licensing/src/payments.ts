export interface VerifiedPayment { eventId: string; paymentId: string; licenseId: string; amountCents: number; }
export interface PaymentProvider {
  readonly name: string;
  createSubscription(input: { licenseId: string; amountCents: number }): Promise<{ id: string; url?: string }>;
  cancelSubscription(id: string): Promise<void>;
  getSubscription(id: string): Promise<{ status: string; currentPeriodEnd: number }>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<VerifiedPayment>;
}
// No public manual/mock payment adapter: manual payments require a recent SUPER_ADMIN login.
export const paymentProviders = new Map<string, PaymentProvider>();
