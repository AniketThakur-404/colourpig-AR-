import type { Metadata } from "next";
import { CONTACT_EMAIL, LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy | Colourpig",
  description: "How Colourpig collects, uses and protects your personal information.",
};

export default function PrivacyPolicyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="28 November 2026" current="/policies/privacy-policy">
      <p>
        Colourpig is a brand of Norman Brown Pty Ltd (&quot;we&quot;, &quot;us&quot;). This policy explains what
        personal information we collect when you visit colourpig.com or buy from us, how we use it, and the choices
        you have. We handle personal information in line with the Australian Privacy Principles in the Privacy Act
        1988 (Cth) and, for customers in the European Union, the General Data Protection Regulation (GDPR).
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Order details:</strong> your name, email, phone number, shipping and billing address, and what you
          bought. Payments are processed by our checkout provider; we never see or store your full card number.
        </li>
        <li>
          <strong>Account and subscription details:</strong> your delivery schedule and order history if you
          subscribe to refills.
        </li>
        <li>
          <strong>Messages:</strong> anything you send us by email or through forms on the site, including shade
          consultations.
        </li>
        <li>
          <strong>Browsing information:</strong> your device, browser, pages viewed and items added to your bag.
          Your bag and favourites are saved in your own browser so they are still there when you return.
        </li>
      </ul>

      <h2>How we use it</h2>
      <ul>
        <li>To process, ship and support your orders and subscriptions.</li>
        <li>To answer your questions and help you choose a shade.</li>
        <li>To send marketing emails, only if you have agreed to receive them. You can unsubscribe at any time.</li>
        <li>To understand how the site is used so we can improve it, and to prevent fraud.</li>
      </ul>

      <h2>Who we share it with</h2>
      <p>
        We do not sell your personal information. We share it only with service providers that help us run the
        business, such as our e-commerce and checkout platform, website hosting, payment processors, email
        providers and delivery companies. They may only use it to provide their service to us. Some of these
        providers store data outside Australia, including in the United States and the European Union.
      </p>

      <h2 id="virtual-try-on" className="scroll-mt-40">Virtual Try-On</h2>
      <p>
        Our Virtual Try-On lets you preview Colourpig shades on your own hair using your device&apos;s camera or a
        photo you choose. Before it starts, we ask you to confirm that you are 18 or older and that you agree to the
        processing described here.
      </p>
      <ul>
        <li>
          <strong>What it does:</strong> the try-on looks at each camera frame or your photo to work out which parts
          are hair and which are face and skin, so it can recolour only your hair.
        </li>
        <li>
          <strong>Where it happens:</strong> entirely inside your browser, on your device. Your camera feed and photos
          are never uploaded to us or to anyone else, and we cannot see them.
        </li>
        <li>
          <strong>What is kept:</strong> nothing. Each frame is discarded once it has been shown, and closing the
          try-on stops the camera. We do not create, store or share a face template or any other biometric record,
          and we never use the try-on to identify you. Pictures you save with the try-on are saved only to your own
          device.
        </li>
        <li>
          <strong>Your consent:</strong> we remember in your browser that you agreed, so you are not asked every
          time. You can withdraw it at any time by clearing this site&apos;s data in your browser settings, and you can
          block camera access for this site whenever you like.
        </li>
        <li>
          <strong>A simulation only:</strong> the preview is a guide. Your real result depends on your natural colour,
          how much grey you have and any previous colouring.
        </li>
      </ul>

      <h2>Cookies</h2>
      <p>
        We use cookies and similar technologies to keep the site working, remember your bag and, where you allow
        it, measure site traffic and the performance of our advertising. You can block or delete cookies in your
        browser settings, though some parts of the site may not work without them.
      </p>

      <h2>How long we keep it</h2>
      <p>
        We keep order records for as long as we need them for tax and accounting purposes, and other information
        only as long as it is useful for the purposes above.
      </p>

      <h2>Your choices and rights</h2>
      <p>
        You can ask to see the personal information we hold about you, ask us to correct it, or ask us to delete
        it. If you are in the European Union you can also object to or restrict how we use it, and ask for a copy
        to take elsewhere. Email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> and we will reply within
        30 days.
      </p>
      <p>
        If you are not happy with our response, you can complain to the Office of the Australian Information
        Commissioner (oaic.gov.au) or, in the EU, to your local data protection authority.
      </p>

      <h2>Changes to this policy</h2>
      <p>
        We may update this policy from time to time. The date at the top of this page shows when it last changed.
      </p>
    </LegalPage>
  );
}
