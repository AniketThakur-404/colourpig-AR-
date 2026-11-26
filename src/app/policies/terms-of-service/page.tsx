import type { Metadata } from "next";
import Link from "next/link";
import { CONTACT_EMAIL, LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service | Colourpig",
  description: "The terms that apply when you use colourpig.com and buy Colourpig products.",
};

export default function TermsOfServicePage() {
  return (
    <LegalPage title="Terms of Service" updated="17 November 2026" current="/policies/terms-of-service">
      <p>
        These terms apply when you use colourpig.com or buy Colourpig products from Norman Brown Pty Ltd
        (&quot;we&quot;, &quot;us&quot;), Sydney, Australia. By placing an order you agree to them. Nothing in these
        terms limits your rights under the Australian Consumer Law or other consumer laws that apply to you.
      </p>

      <h2>Products and use</h2>
      <p>
        Colourpig is a permanent hair colour. Always read the instructions and safety information in the pack, and
        do a skin allergy test 48 hours before every use, even if you have used the product before. Do not use it if
        you have had a reaction to hair colour, or on eyebrows or eyelashes. Shade photos are a guide only: results
        depend on your natural colour, hair condition and any previous colouring.
      </p>

      <h2>Orders and pricing</h2>
      <p>
        Prices are shown in Australian dollars and include GST unless stated otherwise. Your order is accepted when
        we send a confirmation email. We may cancel an order and refund you in full if a product is unavailable or
        a price was clearly displayed in error.
      </p>

      <h2>Subscribe &amp; save</h2>
      <p>
        Refill subscriptions renew automatically at the frequency you choose, and we charge your saved payment
        method before each delivery. You can skip, change or cancel a subscription at any time before the next
        renewal date, from the link in your order emails or by emailing us.
      </p>

      <h2>Shipping</h2>
      <p>
        We ship within Australia and to selected international destinations. Delivery times are estimates. Risk in
        the products passes to you on delivery. International orders may attract import duties and taxes, which are
        your responsibility.
      </p>

      <h2>Returns and refunds</h2>
      <p>
        See our <Link href="/policies/refund-policy">Returns &amp; Refunds policy</Link>.
      </p>

      <h2>Website content</h2>
      <p>
        All content on this site, including text, photos, videos, the Colourpig name and logo, belongs to us or our
        licensors. You may not copy or reuse it without our written permission.
      </p>

      <h2>Liability</h2>
      <p>
        To the extent the law allows, we are not liable for indirect or consequential loss, or for results caused by
        not following the product instructions. Our goods come with guarantees that cannot be excluded under the
        Australian Consumer Law.
      </p>

      <h2>Governing law</h2>
      <p>
        These terms are governed by the laws of New South Wales, Australia. If you live in the European Union, you
        also keep the protection of the mandatory consumer laws of your country.
      </p>

      <h2>Contact</h2>
      <p>
        Norman Brown Pty Ltd, 46 Oxford Street, Paddington NSW 2021, Australia.{" "}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </p>
    </LegalPage>
  );
}
