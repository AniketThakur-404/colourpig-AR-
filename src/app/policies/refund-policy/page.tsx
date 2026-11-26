import type { Metadata } from "next";
import { CONTACT_EMAIL, LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = {
  title: "Returns & Refunds | Colourpig",
  description: "How to return a Colourpig product, our 30-day colour guarantee, and how refunds work.",
};

export default function RefundPolicyPage() {
  return (
    <LegalPage title="Returns & Refunds" updated="17 November 2026" current="/policies/refund-policy">
      <p>
        We want you to love your colour. This policy explains what you can return and how refunds work. It is in
        addition to your rights under the Australian Consumer Law, which entitle you to a repair, replacement or
        refund if a product is faulty, unsafe or not as described.
      </p>

      <h2>30-day colour guarantee</h2>
      <p>
        If your shade match is not right, contact us within 30 days of delivery. Our colourists will help you find
        a better shade and exchange your kit for free, or give you a full refund.
      </p>

      <h2>Change of mind</h2>
      <p>
        For hygiene reasons we can only accept change-of-mind returns of products that are unopened, unused and in
        their original packaging, within 30 days of delivery. Return postage for change-of-mind returns is paid by
        you.
      </p>

      <h2>Faulty or damaged items</h2>
      <p>
        If your order arrives damaged, faulty or incorrect, email us within 7 days of delivery with your order number
        and a photo. We will send a replacement or refund you in full, including postage.
      </p>

      <h2>How to return</h2>
      <ul>
        <li>
          Email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> with your order number and the reason for the
          return.
        </li>
        <li>We will reply with the return address and next steps. Please don&apos;t send items back without contacting us first.</li>
        <li>Use a tracked postage service. We can&apos;t refund items lost on the way back to us.</li>
      </ul>

      <h2>Refunds</h2>
      <p>
        Once we receive and check your return, we refund the original payment method within 5 business days. Your
        bank may take a few more days to show the money in your account. Original shipping costs are refunded only
        when the item was faulty, damaged or incorrect.
      </p>

      <h2>Subscriptions</h2>
      <p>
        You can cancel a refill subscription at any time before the next renewal date. If a renewal has already been
        charged and not yet shipped, email us and we will cancel and refund it.
      </p>

      <h2>Customers in the European Union</h2>
      <p>
        If you live in the EU, you can also cancel an order within 14 days of delivery without giving a reason.
        Opened products cannot be returned under this right for hygiene reasons.
      </p>
    </LegalPage>
  );
}
