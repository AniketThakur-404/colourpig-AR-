/** Policy pages, in the order they appear in the footer and the policy page switcher. */
export const LEGAL_PAGES = [
  { href: "/policies/privacy-policy", label: "Privacy Policy" },
  { href: "/policies/terms-of-service", label: "Terms of Service" },
  { href: "/policies/refund-policy", label: "Returns & Refunds" },
] as const;

export type LegalPageHref = (typeof LEGAL_PAGES)[number]["href"];

/** Where privacy and policy questions go. */
export const CONTACT_EMAIL = "hello@colourpig.com";
